/**
 * 관광지 목록과 사실 데이터를 **구글 Places 에서 받아온다.**
 *
 * **왜 모델이 아니라 구글인가** — "오사카에 어떤 관광지가 있나" 는 정답이 있는 사실이다.
 * 모델에게 물으면 폐관한 곳이나 아예 없는 곳을 그럴듯하게 섞는데, 사용자는 현장에
 * 가서야 안다. 구글 목록에서 출발하면 **존재하지 않는 곳이 들어올 자리가 없다.**
 *
 * ⚠️ **모델이 하던 일을 전부 뺏지는 않는다.** 구글 순서는 인기·거리 기준이라
 *    "처음 가는 한국인에게 뭘 먼저 보여줄까" 는 못 한다 — 현지인 기준 장소가 섞이고
 *    한국인에게만 유명한 곳이 빠진다. **고르는 건 여전히 모델이 한다**
 *    ([openai.provider.ts](./providers/openai.provider.ts)). 여기는 후보를 모을 뿐이다.
 *
 * **비용 구조.** 도시 한 곳에 타입 수만큼 호출한다(기본 6회). 관광지 하나당 한 번이
 * 아니라 **도시 하나당 여섯 번**이라, 도시 100곳을 28일에 나눠 갱신해도 월 600회다.
 * 응답에 필드가 같이 오므로 Place Details 를 따로 부를 필요가 없다.
 *
 * ⚠️ **저장 제약.** 구글 약관은 place_id 외의 콘텐츠를 오래 보관하는 걸 제한한다.
 *    그래서 영구 저장하는 건 place_id 뿐이고(attraction_places), 이름·평점 같은 건
 *    30일 캐시(search_results)에만 산다. 만료된 캐시는 실제로 지운다 —
 *    "만료돼도 보여주기" 를 관광지에서만 끈 이유가 그것이다.
 *
 * ⚠️ **사진은 여기서 안 받는다.** Places 사진은 주소가 만료되는데, 카카오 카드는
 *    단톡방에 영구히 남아서 사람들이 나중에 스크롤해 다시 본다 — 며칠 뒤 깨진 자리가
 *    남는다. 사진은 주소가 안 죽는 위키미디어에서 찾는다([attraction-image.ts]).
 */

import { fetchWithTimeout } from '../../common/fetch';
import { text } from '../../common/parse';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * 어떤 축으로 후보를 모을지. **구글 타입이 곧 카테고리 다양성이다.**
 *
 * 한 번에 "오사카 관광지" 로 부르면 유명한 신사 스무 곳이 나온다. 타입을 갈라 부르면
 * 섞는 일을 쿼리가 대신한다 — 모델에게 "카테고리를 반드시 섞어라" 라고 사정할 필요가
 * 없어진다.
 *
 * 한국어 이름은 카드에 찍히는 값이라 여기서 정한다. 구글 타입 문자열을 그대로 쓰면
 * 카드에 'tourist_attraction' 이 나간다.
 */
export const PLACE_TYPES: { type: string; category: string }[] = [
  { type: 'tourist_attraction', category: '관광명소' },
  { type: 'historical_landmark', category: '역사/문화' },
  { type: 'museum', category: '미술관/박물관' },
  { type: 'park', category: '자연/공원' },
  { type: 'shopping_mall', category: '거리/쇼핑' },
  { type: 'amusement_park', category: '테마파크' },
];

/** 한 번에 받을 후보 수. New Places API 의 상한이 20 이다. */
const PER_TYPE = 20;

const FIELDS = [
  // Essentials — 신원·위치
  'places.id',
  'places.location',
  'places.addressComponents',
  'places.formattedAddress',
  'places.types',
  // Pro — 표시 이름. 구글 지도에 뜨는 그 표기라 카드와 지도가 어긋나지 않는다.
  'places.displayName',
  // Enterprise — 평점. 카드 한 줄의 주인공이다.
  'places.rating',
  'places.userRatingCount',
];

/** 구글이 알려준 관광지 한 곳. */
export interface PlaceCandidate {
  /** 구글이 부여한 신원. **이것만 영구 저장한다.** */
  placeId: string;
  name: string;
  /** 도시 안에서의 위치 (주오구·우메다). 주소 구성요소에서 뽑는다. */
  area: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  userRatingCount: number | null;
  /** 우리 카테고리. 어떤 타입으로 검색해서 걸렸는지가 곧 이 값이다. */
  category: string;
}

export interface PlaceSearchOptions {
  apiKey: string;
  timeoutMs: number;
  /** 타입 하나당 몇 곳까지. 기본 20(구글 상한). */
  perType?: number;
}

interface RawPlace {
  id?: unknown;
  displayName?: { text?: unknown } | null;
  formattedAddress?: unknown;
  addressComponents?: unknown;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  rating?: unknown;
  userRatingCount?: unknown;
}

/**
 * 도시 하나의 관광지 후보를 모은다. 타입마다 한 번씩 부르고 **place_id 로 중복을 없앤다.**
 *
 * 같은 장소가 여러 타입에 걸린다(오사카성은 tourist_attraction 이자 historical_landmark).
 * 먼저 걸린 타입의 카테고리를 쓴다 — PLACE_TYPES 순서가 곧 우선순위다.
 *
 * ⚠️ 한 타입이 실패해도 나머지는 살린다. 여섯 번 중 한 번이 죽었다고 도시 전체를
 *    포기하면, 구글이 잠깐 흔들릴 때마다 그 도시가 통째로 비게 된다.
 */
export async function searchCityAttractions(
  cityName: string,
  opts: PlaceSearchOptions,
): Promise<PlaceCandidate[]> {
  const results = await Promise.all(
    PLACE_TYPES.map(({ type, category }) => searchByType(cityName, type, category, opts)),
  );

  const byPlaceId = new Map<string, PlaceCandidate>();
  for (const candidate of results.flat()) {
    if (!byPlaceId.has(candidate.placeId)) byPlaceId.set(candidate.placeId, candidate);
  }
  return [...byPlaceId.values()];
}

async function searchByType(
  cityName: string,
  type: string,
  category: string,
  opts: PlaceSearchOptions,
): Promise<PlaceCandidate[]> {
  try {
    return await fetchWithTimeout(
      SEARCH_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': opts.apiKey,
          // 필드 마스크는 **필수**이고 곧 요금이다. 넓게 잡으면 그만큼 비싸진다.
          'X-Goog-FieldMask': FIELDS.join(','),
        },
        body: JSON.stringify({
          textQuery: `${cityName} ${category}`.trim(),
          includedType: type,
          // 카드도 DB 도 한국어다. 주소·이름을 한국어 표기로 받는다.
          languageCode: 'ko',
          maxResultCount: opts.perType ?? PER_TYPE,
        }),
      },
      opts.timeoutMs,
      async (res) => {
        if (!res.ok) return [];
        const body = (await res.json()) as { places?: unknown };
        if (!Array.isArray(body.places)) return [];
        return body.places
          .map((raw) => toCandidate(raw as RawPlace, category))
          .filter((c): c is PlaceCandidate => c !== null);
      },
    );
  } catch {
    // 한 타입이 죽어도 나머지로 목록을 만든다.
    return [];
  }
}

export function toCandidate(raw: RawPlace, category: string): PlaceCandidate | null {
  const placeId = text(raw.id);
  const name = text(raw.displayName?.text);
  // 신원과 이름이 없으면 카드에도 DB 에도 쓸 수 없다.
  if (!placeId || !name) return null;

  return {
    placeId,
    name,
    area: areaOf(raw.addressComponents),
    address: text(raw.formattedAddress),
    lat: finite(raw.location?.latitude),
    lng: finite(raw.location?.longitude),
    // 5점 만점이다. 벗어나면 우리가 잘못 읽은 것이므로 버린다.
    rating: inRange(raw.rating, 0, 5),
    userRatingCount: nonNegativeInt(raw.userRatingCount),
    category,
  };
}

/**
 * 주소 구성요소에서 **도시 안에서의 위치**를 뽑는다 (주오구·우메다).
 *
 * 카드 한 줄에 도시 이름을 다시 쓰는 건 의미가 없다 — 사용자는 이미 그 도시를
 * 물어봤다. 그래서 `locality`(도시)가 아니라 그 아래 단위를 고른다.
 */
export function areaOf(components: unknown): string | null {
  if (!Array.isArray(components)) return null;

  // 좁은 단위부터. 없으면 다음 단위로 내려간다.
  for (const type of ['sublocality_level_1', 'sublocality', 'neighborhood']) {
    for (const raw of components) {
      const component = raw as { types?: unknown; longText?: unknown } | null;
      if (!Array.isArray(component?.types) || !component.types.includes(type)) continue;
      const name = text(component.longText);
      if (name) return name;
    }
  }
  return null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inRange(value: unknown, min: number, max: number): number | null {
  const n = finite(value);
  return n !== null && n >= min && n <= max ? n : null;
}

function nonNegativeInt(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n >= 0 ? Math.round(n) : null;
}

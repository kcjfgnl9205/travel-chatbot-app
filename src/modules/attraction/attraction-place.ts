/**
 * 관광지의 **사실 데이터**를 구글 Places 에서 받아온다.
 *
 * **왜 모델에게 안 묻나** — 주소·좌표·운영시간·평점은 장소마다 정답이 하나인 사실이다.
 * 이런 걸 LLM 에게 물으면 모르는 것도 그럴듯하게 채운다. 이 저장소가 이미 세 번 겪었다:
 * 1,200엔이 '5,760원' 이 됐고, 이미지 주소는 존재하지 않는 CDN 링크였고,
 * "유니버설 스튜디오 재팬" 이 **싱가포르** 사진을 물고 왔다.
 * Places 는 구조화된 응답이라 **지어낼 자리가 없고, 모르면 그 필드가 아예 안 온다.**
 *
 * ⚠️ **모델이 하던 일을 뺏지 않는다.** "어디를 추천할 것인가" 는 Places 가 못 한다.
 *    인기순·거리순으로 주기 때문에 카테고리가 쏠린다(신사 다섯 곳). 고르는 건 모델이,
 *    고른 것의 사실 확인은 여기가 한다. 그래서 **프롬프트에는 주소·평점을 묻는 칸이
 *    없다** — 물어보면 지어낼 기회를 주는 것이고, 두 출처가 같은 칸을 채우면 어느
 *    쪽이 맞는지 판정하는 일이 새로 생긴다.
 *
 * ⚠️ 키가 없으면 통째로 건너뛴다. 사진과 같은 취급이다 — 있으면 좋지만 없다고
 *    관광지 추천이 실패하면 안 된다.
 *
 * **비용.** Text Search 한 번이 관광지 한 곳이다. 도시 1곳당 최대 20회이고 결과가
 * 30일 캐시되므로 한 달에 도시 500곳까지가 Essentials 무료 한도 안이다.
 * 평점·운영시간(GOOGLE_PLACES_RATINGS)은 **더 비싼 티어**라 무료 한도가 훨씬 작다 —
 * 켤 거면 GOOGLE_PLACES_LIMIT 으로 건수를 줄여야 한다.
 *
 * ⚠️ **저장 제약.** 구글 약관은 place_id 외의 콘텐츠를 오래 보관하는 걸 제한한다.
 *    평점·운영시간을 노출 스냅샷에 영구 보관하는 게 걸릴 수 있으니, 그 필드를 켜기
 *    전에 현재 약관을 확인하라. place_id 는 영구 저장이 명시적으로 허용된다.
 */

import { fetchWithTimeout } from '../../common/fetch';
import { text } from '../../common/parse';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * 어떤 필드를 달라고 할지. **요청한 필드 중 가장 높은 티어로 과금된다.**
 *
 *   Essentials  id · formattedAddress · location      ← 기본
 *   Enterprise  rating · userRatingCount · 운영시간 · websiteUri
 *
 * 그래서 둘을 갈라 둔다. 평점을 안 쓰는 동안에는 싼 티어로만 돈다.
 */
const BASIC_FIELDS = ['places.id', 'places.formattedAddress', 'places.location'];
const RATING_FIELDS = [
  'places.rating',
  'places.userRatingCount',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.websiteUri',
];

/** Places 가 알려준 사실. 못 찾으면 null 이고, 찾아도 필드는 비어 올 수 있다. */
export interface FoundPlace {
  placeId: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  userRatingCount: number | null;
  /** 요일별 영업시간 문장 7줄. 구글이 언어에 맞춰 만들어 준다. */
  openingHours: string[] | null;
  website: string | null;
}

interface RawPlace {
  id?: unknown;
  formattedAddress?: unknown;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  rating?: unknown;
  userRatingCount?: unknown;
  regularOpeningHours?: { weekdayDescriptions?: unknown } | null;
  websiteUri?: unknown;
}

export interface PlaceLookupOptions {
  apiKey: string;
  timeoutMs: number;
  /** 평점·리뷰수·운영시간·홈페이지까지 받을지. 더 비싼 티어다. */
  ratings: boolean;
}

/**
 * 관광지 한 곳을 찾는다. 못 찾으면 null.
 *
 * 이름만으로 검색하지 않는다 — "중앙공원" 은 전 세계에 있다. 도시를 붙여야
 * 엉뚱한 나라의 동명 장소를 집지 않는다 (지도 링크를 만들 때와 같은 이유다).
 *
 * `maxResultCount: 1` 인 이유: 우리는 이미 어느 장소인지 알고 사실만 채우러 온 것이라
 * 후보를 비교할 게 없다. 여러 개를 받아봐야 고를 근거가 없다.
 */
export async function findPlace(
  name: string,
  cityName: string,
  opts: PlaceLookupOptions,
): Promise<FoundPlace | null> {
  const fields = opts.ratings ? [...BASIC_FIELDS, ...RATING_FIELDS] : BASIC_FIELDS;

  try {
    return await fetchWithTimeout(
      SEARCH_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': opts.apiKey,
          // 필드 마스크는 **필수**다. 빼면 400 이 오고, 넓게 잡으면 그만큼 비싸진다.
          'X-Goog-FieldMask': fields.join(','),
        },
        body: JSON.stringify({
          textQuery: `${name} ${cityName}`.trim(),
          // 한국어 주소·영업시간 문장으로 받는다. 카드와 DB 가 한국어다.
          languageCode: 'ko',
          maxResultCount: 1,
        }),
      },
      opts.timeoutMs,
      async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { places?: unknown };
        const first = Array.isArray(body.places) ? (body.places[0] as RawPlace) : null;
        return first ? toFoundPlace(first) : null;
      },
    );
  } catch {
    // 사실 데이터는 있으면 좋은 것이지 없으면 안 되는 것이 아니다. 조용히 넘긴다 —
    // 구글이 느리다고 관광지 추천이 통째로 실패하면 안 된다.
    return null;
  }
}

export function toFoundPlace(raw: RawPlace): FoundPlace | null {
  const placeId = text(raw.id);
  // place_id 가 없으면 나머지가 있어도 쓸 수 없다. 그게 이 장소의 신원이다.
  if (!placeId) return null;

  return {
    placeId,
    address: text(raw.formattedAddress),
    lat: finite(raw.location?.latitude),
    lng: finite(raw.location?.longitude),
    // 평점은 5점 만점이다. 범위를 벗어나면 우리가 잘못 읽은 것이므로 버린다.
    rating: inRange(raw.rating, 0, 5),
    userRatingCount: nonNegativeInt(raw.userRatingCount),
    openingHours: weekdayLines(raw.regularOpeningHours?.weekdayDescriptions),
    website: httpsUrl(raw.websiteUri),
  };
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

/** 요일 7줄. 하나라도 문자열이 아니면 통째로 버린다 — 반쪽짜리 영업시간은 위험하다. */
function weekdayLines(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const lines = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return lines.length === value.length ? lines : null;
}

/** 카드에 실을 수도 있는 주소다. http 는 받지 않는다. */
function httpsUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

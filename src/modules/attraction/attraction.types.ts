/**
 * 관광지 1건.
 *
 * **출처가 셋으로 갈린다. 그게 이 타입의 전부다.**
 *
 *   구글 Places   placeId · name · category · area · address · lat/lng · rating · 리뷰수
 *                 → **사실**이다. 정답이 하나뿐인 값은 모델에게 묻지 않는다
 *   위키미디어    imageUrl → 주소가 죽지 않아서 캐시·카드에 그대로 담을 수 있다
 *   우리          mapUrl → placeId 로 만든 정확한 핀
 *
 * 모델은 이 중 아무 칸도 채우지 않는다. **순서만 정한다** —
 * "처음 가는 한국인에게 뭘 먼저 보여줄까" 는 구글이 못 하는 판단이기 때문이다.
 *
 * 호텔·항공권과 달리 **예약 주소가 없다.** 관광지는 파는 물건이 아니라 장소라서
 * sourceUrl 도 merchant 도 없고, 우리가 만든 지도 링크가 유일한 바깥 링크다.
 */
export interface Attraction {
  /**
   * 구글이 부여한 장소 신원.
   *
   * **이름 표기가 흔들려도 같은 곳으로 묶인다** — 중복 판정도 이 값이 맡는다.
   * 그리고 구글 약관상 **영구 저장이 명시적으로 허용되는 거의 유일한 값**이라,
   * DB 에 오래 남는 관광지 정보는 사실상 이것뿐이다(attraction_places).
   */
  placeId: string;
  /** 구글 지도에 뜨는 그 표기. 카드 제목과 지도가 어긋나지 않는다. */
  name: string;
  citySlug: string;
  /** 관광명소 · 역사/문화 · 미술관/박물관 · 자연/공원 · 거리/쇼핑 · 테마파크 */
  category?: string | null;
  /** 도시 안에서의 위치. 카드 설명에 들어간다 (주오구, 우메다). */
  area?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;

  /**
   * 구글 평점(5점 만점)과 리뷰 수. **카드 한 줄의 주인공이다.**
   *
   * ⚠️ 모델에게 묻지 않는다. 구체적인 숫자는 LLM 이 가장 잘 지어내는 종류다.
   * ⚠️ 30일 캐시에만 산다. 노출 스냅샷에 영구 보관하지 않는다 — 구글 약관이
   *    place_id 외 콘텐츠의 장기 보관을 제한한다.
   */
  rating?: number | null;
  userRatingCount?: number | null;

  /**
   * 영문·현지 공식명. 카드에는 안 쓴다.
   *
   * **위키미디어 영어판·커먼즈를 검색하려고 받는다.** 한국어 문서가 없는 관광지가
   * 동남아에 특히 많은데, 영문명이 있으면 거기서 사진을 찾을 수 있다.
   */
  nameEn?: string | null;

  /**
   * 카드 썸네일. 위키미디어에서 찾는다([attraction-image.ts](./attraction-image.ts)).
   *
   * ⚠️ **없을 수 있다.** 사진을 못 구했다고 관광지를 목록에서 빼지는 않는다 —
   *    추천 자체가 사라지는 게 사진 한 장 없는 것보다 나쁘다.
   */
  imageUrl?: string | null;

  /**
   * 구글맵 링크. **모델이 준 게 아니라 [maps-url.ts](../../common/maps-url.ts) 가 만든다.**
   *
   * placeId 가 있으므로 검색이 아니라 그 장소를 정확히 연다.
   */
  mapUrl: string;
}

export interface AttractionQuery {
  citySlug: string;
  cityName: string;
  limit: number;
}

/** 캐시에서 살려낸 값이 관광지 모양인가. 배포로 필드가 바뀌면 미스로 떨어뜨린다. */
export function isAttraction(item: unknown): item is Attraction {
  if (!item || typeof item !== 'object') return false;
  const a = item as Attraction;
  return typeof a.name === 'string' && typeof a.mapUrl === 'string';
}

/**
 * 같은 관광지인지 판정하는 키.
 *
 * **구글 신원이 곧 답이다.** 이름으로 판정하면 '오사카성' / '오사카 성' /
 * 'Osaka Castle' 이 전부 다른 값이 되는데, place_id 는 표기와 무관하게 같다.
 */
export function attractionKey(a: Attraction): string {
  return a.placeId;
}

export interface AttractionProvider {
  readonly name: string;
  /**
   * 지금 검색을 할 수 있는 상태인가 (API 키 등). 안 주면 할 수 있는 것으로 본다.
   *
   * ⚠️ 이게 없으면 키가 빠진 서버가 **지키지 못할 약속**을 한다 —
   *    "30초쯤 뒤에 다시 물어봐 주세요" 라고 해놓고 영원히 결과가 없다.
   */
  readonly enabled?: boolean;
  /**
   * ⚠️ 느릴 수 있다(구글 6회 + 모델 1회 + 사진 N회). 호출부는 반드시 백그라운드에서만
   * 부른다. 카카오 5초 예산 안에서 도는 건 캐시 조회뿐이다.
   */
  search(query: AttractionQuery): Promise<Attraction[]>;
}

/**
 * provider DI 토큰.
 *
 * 구현을 직접 주입하지 않는 이유: 테스트에서 가짜 provider 로 갈아끼워야 하고
 * (실제 구글·OpenAI 를 부르면 안 된다), 설정으로도 바뀐다.
 */
export const ATTRACTION_PROVIDER = 'ATTRACTION_PROVIDER';

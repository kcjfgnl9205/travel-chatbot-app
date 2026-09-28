/**
 * 관광지 1건.
 *
 * **출처가 하나다. 그게 0008 과 달라진 전부다.**
 *
 *   우리 DB   name · area · imageUrl → 사람이 관리 화면에서 넣은 값
 *   우리      mapUrl                 → 이름+도시로 만든 지도 링크
 *
 * 구글 Places 도 모델도 위키미디어도 부르지 않는다. 그 셋을 걷어내면서 사라진 칸이
 * 많다 — 평점·리뷰수·카테고리·주소·좌표·영문명. 전부 남의 콘텐츠였고, 보관 제한과
 * 출처 표시 의무와 API 요금이 거기 붙어 있었다.
 *
 * ⚠️ **모델이 사실을 채우던 자리가 아예 없어졌다.** 0008 은 "모델은 순서만 정한다"
 *    였는데, 이제 순서도 사람이 정한다. 관광지 도메인에 LLM 이 닿는 곳은 없다.
 *
 * 호텔·항공권과 달리 **예약 주소가 없다.** 관광지는 파는 물건이 아니라 장소라서
 * sourceUrl 도 merchant 도 없고, 우리가 만든 지도 링크가 유일한 바깥 링크다.
 */
export interface Attraction {
  /**
   * 우리 DB 의 신원 (`attractions.id`).
   *
   * **이름이 바뀌어도 같은 곳으로 묶인다** — 중복 판정도 노출 집계도 이 값이 맡는다.
   * 0008 까지는 구글 place_id 가 하던 역할이다.
   */
  id: number;
  /** 카드 제목. 관리 화면에 입력한 그대로 나간다. */
  name: string;
  citySlug: string;
  /**
   * 도시 안에서의 위치 (주오구 · 우메다).
   *
   * **카드 설명 한 줄이 이 값 하나다.** 평점·카테고리를 함께 찍던 자리인데 둘 다
   * 구글에서 오던 값이라 같이 걷어냈다. 비어 있으면 설명 없이 제목만 나간다.
   */
  area?: string | null;
  /**
   * 카드 썸네일.
   *
   * ⚠️ **없을 수 있다.** 사진을 안 넣었다고 관광지를 목록에서 빼지는 않는다 —
   *    추천 자체가 사라지는 게 사진 한 장 없는 것보다 나쁘다.
   * ⚠️ **https 여야 한다.** 카카오는 http 이미지를 그리지 않는다.
   */
  imageUrl?: string | null;

  /**
   * 구글맵 링크. **[maps-url.ts](../../common/maps-url.ts) 가 만든다.**
   *
   * 0008 까지는 place_id 를 붙여 그 장소를 정확히 열었는데, 그 값을 더 이상 받지
   * 않으므로 이름+도시 검색으로 돌아간다. 링크 자체는 무료이고 약관과 무관하다.
   */
  mapUrl: string;
}

export interface AttractionQuery {
  /** `attractions.city_id` 로 쓴다. 조회의 유일한 열쇠다. */
  cityId: number;
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
 * **DB 신원이 곧 답이다.** 이름으로 판정하면 관리 화면에서 표기를 고치는 순간
 * 다른 곳이 되는데, id 는 그대로다.
 */
export function attractionKey(a: Attraction): string {
  return String(a.id);
}

export interface AttractionProvider {
  readonly name: string;
  /**
   * 지금 조회를 할 수 있는 상태인가 (DB 연결 등). 안 주면 할 수 있는 것으로 본다.
   *
   * ⚠️ 이게 없으면 DB 가 빠진 서버가 **지키지 못할 약속**을 한다 —
   *    "30초쯤 뒤에 다시 물어봐 주세요" 라고 해놓고 영원히 결과가 없다.
   */
  readonly enabled?: boolean;
  /**
   * ⚠️ **빠르다 (DB 쿼리 하나).** 0008 까지는 구글 6회 + 모델 2회 + 사진 N회라
   *    백그라운드에서만 불러야 했는데, 이제 요청 경로에서 그대로 돈다.
   */
  search(query: AttractionQuery): Promise<Attraction[]>;
}

/**
 * provider DI 토큰.
 *
 * 구현을 직접 주입하지 않는 이유: 테스트에서 가짜 provider 로 갈아끼워야 한다
 * (실제 DB 를 붙이면 안 된다).
 */
export const ATTRACTION_PROVIDER = 'ATTRACTION_PROVIDER';

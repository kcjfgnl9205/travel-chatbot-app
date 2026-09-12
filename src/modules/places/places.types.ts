/**
 * 지역(place) 의 자료구조.
 *
 * **캐시 적중률이 전부 여기서 결정된다.** "오사카" / "osaka" / "오사카시" 가 같은
 * place 로 모이지 않으면 같은 지역을 물을 때마다 AI 검색이 새로 돈다.
 *
 * 목록을 미리 채우지 않는다 — 사전([city-table.ts](./city-table.ts))에 있으면 거기서,
 * 없으면 모델에게 표준명을 물어 등록한다. **쓰면서 자란다.**
 */

export type PlaceKind = 'city' | 'area' | 'landmark';

export interface Place {
  /** DB 의 bigint. DB 가 없으면 프로세스 안에서만 유효한 번호다. */
  id: number;
  /** 사용자에게 보여줄 표준 한국어명. 오타는 교정된 상태. */
  canonicalName: string;
  /** 검색 질의·통계에 쓰는 영문 슬러그 (osaka, dotonbori). */
  slug: string;
  /** 'JP', 'KR'. 모르면 null. */
  countryCode: string | null;
  kind: PlaceKind;
  /** 대표 공항 IATA 3자. 공항이 없는 지역은 null (교토·도톤보리). */
  iata: string | null;
  /** 도톤보리 → 오사카. 세부 지역만 값이 있다. */
  parentId: number | null;
}

/** 새로 등록할 지역. id 는 저장소가 붙인다. */
export type PlaceDraft = Omit<Place, 'id'>;

/**
 * 별칭 정규화 키. **공백 제거 + 소문자.**
 *
 * place_aliases 의 기본키이고, 표기가 흔들려도 같은 지역으로 모이게 하는 유일한 장치다.
 */
export function aliasKey(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * 슬러그 정규화.
 *
 * 모델이 'New York' 이나 'Osaka' 처럼 줘도 키가 갈리지 않게 한다. 한글이 오면
 * 한글 그대로 둔다 — text 컬럼이라 문제없고, 모델에게는 영문 슬러그를 요구한다.
 */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '');
}

/** 지역명을 그대로 검색어로 쓸 수 있는 형태로. '도톤보리' → '도톤보리(오사카)'. */
export function placeLabel(place: Place, parent?: Place | null): string {
  if (!parent || parent.id === place.id) return place.canonicalName;
  return `${place.canonicalName}(${parent.canonicalName})`;
}

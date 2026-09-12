import { SearchContext } from './search.types';

/**
 * provider 에게 넘길 지역 이름.
 *
 * 세부 지역은 **부모 도시를 붙인다** — "도톤보리" 만 주면 모델이 어느 나라 이야기인지
 * 모를 수 있고, "도톤보리 오사카" 는 웹 검색에서 그대로 잘 먹는다. 관광지의 지도
 * 링크도 이 문자열로 만들어지므로 붙여두는 편이 정확하다.
 *
 * 카드 머리글에는 쓰지 않는다 — 거기는 사용자가 말한 지역(canonicalName)이어야 한다.
 */
export function searchName(ctx: SearchContext): string {
  const { place, parent } = ctx;
  if (!parent || parent.id === place.id) return place.canonicalName;
  return `${place.canonicalName} ${parent.canonicalName}`;
}

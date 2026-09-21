/**
 * 구글맵 링크.
 *
 * 호텔·항공권과 결정적으로 다른 점: **주소를 모델에게 받지 않고 우리가 만든다.**
 *
 * 예약 도메인에서는 모델이 준 URL 을 써야 해서 호스트 검증([booking-url.ts])이
 * 필요했다 — 모델은 없는 주소를 그럴듯하게 지어내고, 그게 사용자에게 나가면 404 다.
 * 지도는 그럴 이유가 없다. 구글이 공개한 URL 규약에 이름만 끼워 넣으면 되므로
 * **지어낼 자리가 없다.** 검증할 것도, 죽은 링크도 없다.
 *
 * https://developers.google.com/maps/documentation/urls/get-started#search-action
 *
 * ⚠️ **모델이 준 좌표는 쓰지 않는다.** 스키마에 lat/lng 를 넣으면 모델이 채워주긴
 *    하는데, LLM 의 좌표는 그럴듯하고 자주 틀린다. 엉뚱한 곳에 핀이 꽂히는 건 이름으로
 *    검색되는 것보다 나쁘다 — 사용자는 지도가 틀렸다는 걸 현장에서야 안다.
 *
 * 구글 Places 가 준 `place_id` 는 사정이 다르다 — 구글 자신의 식별자라 지어낼 자리가
 * 없다. 있으면 검색이 아니라 **그 장소를 정확히** 연다
 * ([attraction-place.ts](../modules/attraction/attraction-place.ts)).
 */

const MAPS_SEARCH = 'https://www.google.com/maps/search/?api=1&query=';

/**
 * 관광지 이름 + 도시로 구글맵 검색 링크를 만든다.
 *
 * 도시명을 붙이는 이유: "중앙공원", "시립미술관" 같은 이름은 전 세계에 널려 있다.
 * 사용자가 물어본 도시를 같이 넣어야 엉뚱한 나라로 가지 않는다.
 */
export function mapsUrl(
  name: string,
  cityName?: string | null,
  placeId?: string | null,
): string {
  const query = [name.trim(), cityName?.trim()].filter(Boolean).join(' ');
  const url = MAPS_SEARCH + encodeURIComponent(query);
  // place_id 가 있어도 query 는 넣어야 한다 — 구글 규약이 요구하고, 링크를 사람이
  // 봤을 때 어디로 가는지도 드러난다.
  return placeId ? `${url}&query_place_id=${encodeURIComponent(placeId)}` : url;
}

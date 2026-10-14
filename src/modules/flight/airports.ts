import { isKorea } from '../places/city-table';
import { Place } from '../places/places.types';

/**
 * 노선의 공항 코드.
 *
 * **서울은 공항이 둘이라 도시 이름만으로는 공항이 안 정해진다.** 사전은 서울의
 * 대표 공항을 인천(ICN)으로 들고 있는데([city-table.ts](../places/city-table.ts)),
 * 국내선은 거의 전부 김포(GMP)에서 뜬다. 그래서 "제주 항공권" 을 물으면
 * `ICN → CJU` 로 검색이 나갔고, 링크도 그 노선으로 열렸다 — 편수가 몇 배인
 * 김포 노선을 통째로 못 보여준 셈이다.
 *
 * 그래서 **노선이 국내선이면 서울 쪽 끝을 김포로 바꾼다.** 바꾸는 건 공항 코드뿐이고
 * 도시명은 "서울" 그대로다 — 카드 안내("서울 출발 기준이에요")와 캐시 키(place id)가
 * 도시 단위로 돌아가기 때문이다. 같은 (출발지, 도착지) 쌍이면 코드도 매번 같으므로
 * 캐시가 갈리지도 않는다.
 *
 * ⚠️ **"인천" 이라고 콕 집어 말한 사람은 건드리지 않는다.** 그건 도시가 아니라
 *    공항을 고른 발화다. 사전에 `incheon` 행이 따로 있는 이유가 그것이다.
 *
 * ⚠️ **모르면 해외로 친다** — isKorea 가 모르면 false 이고, 그때 인천은 원래 동작이다.
 *    국내인 줄 몰라 인천으로 나가면 "노선이 적다" 지만, 해외인데 김포로 나가면
 *    도쿄·오사카 말고는 아예 노선이 없는 공항으로 검색이 나간다.
 */

/** 인천국제공항. 서울의 국제선 관문이자 사전이 들고 있는 대표 공항. */
const INCHEON = 'ICN';
/** 김포공항. 국내선은 여기가 서울이다. */
const GIMPO = 'GMP';

export interface RouteAirports {
  originCode: string | null;
  destCode: string | null;
}

/**
 * 출발·도착 공항을 한 번에 정한다. **국내선 판정이 양쪽에 같이 걸려야 하므로**
 * 따로 부르지 않는다 — "부산 → 서울" 의 도착지도 김포여야 한다.
 *
 * @param from     출발지. 사용자가 말하지 않았으면 null 이고, 그때는 fallback 이 답이다.
 * @param dest     도착지.
 * @param fallback 출발지를 말하지 않았을 때의 기본값 (설정값: 서울 / ICN).
 */
export function routeAirports(
  from: Place | null,
  dest: Place,
  fallback: { name: string; code: string },
): RouteAirports {
  // 출발지를 안 말했으면 기본값이 출발지다. 설정으로 부산을 기본으로 바꿔도
  // (FLIGHT_DEFAULT_ORIGIN_NAME) 그 이름으로 판정이 돌아야 한다.
  const fromKorea = from
    ? isKorea(from.canonicalName, from.countryCode)
    : isKorea(fallback.name, null);
  const domestic = fromKorea && isKorea(dest.canonicalName, dest.countryCode);

  return {
    originCode: airportOf(from, fallback.code, domestic),
    destCode: airportOf(dest, null, domestic),
  };
}

/**
 * 한쪽 끝의 공항. 서울이 아니면 손대지 않는다 — 공항이 하나뿐인 도시다.
 *
 * 서울인지 슬러그가 아니라 **코드가 ICN 인지로** 본다. 사전에 없어 모델 경로로
 * 등록된 "서울특별시" 같은 행도 ICN 을 들고 오기 때문이다.
 */
function airportOf(
  place: Place | null,
  fallbackCode: string | null,
  domestic: boolean,
): string | null {
  const code = place?.iata ?? fallbackCode;
  if (code !== INCHEON) return code;
  // 공항을 콕 집어 말했다. 국내선이어도 그 사람은 인천에서 뜨는 편을 찾고 있다.
  if (place?.slug === 'incheon') return INCHEON;
  return domestic ? GIMPO : INCHEON;
}

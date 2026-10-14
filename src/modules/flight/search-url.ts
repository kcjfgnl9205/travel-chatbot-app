/**
 * 항공권 **검색 결과** 주소를 만든다.
 *
 * 모델이 주는 건 노선 페이지(`kr.trip.com/flights/airport-icn-cts/`)라 열어보면 빈
 * 검색 폼이다. 사용자는 카드에서 "32만원" 을 보고 눌렀는데 다시 날짜를 입력해야 한다.
 * 그 한 단계가 이탈 지점이다.
 *
 * **검색된 상태를 연다 — 사용자가 말한 날짜·인원으로.** 말하지 않았으면 내일 출발,
 * 7일 뒤 귀국, 1인이다 ([trip-params.ts](./trip-params.ts) 가 발화에서 읽고,
 * 못 읽은 칸의 기본값은 `resolveTrip` 한 곳에만 있다).
 *
 * ⚠️ **저장하면 안 된다. 카드를 그릴 때마다 만든다.**
 *    `search_results` 는 날짜를 캐시 키에 넣지 않고 24시간 산다(0004). URL 에 오늘
 *    날짜를 구워서 저장하면 **내일 캐시를 맞은 사람이 어제 날짜로 검색된 페이지**를
 *    받는다. 관광지 `/a/{id}` 가 목적지를 스냅샷하지 않는 것과 같은 이유다.
 *
 * ⚠️ **형식을 아는 제휴몰만 바꾼다.** 모르면 null 을 주고 호출부가 원본을 쓴다 —
 *    지어낸 주소로 바꾸는 것은 빈 폼을 여는 것보다 나쁘다. 지금은 셋 다 안다
 *    (트립닷컴 · 스카이스캐너 · 마이리얼트립). 넷째가 생기면 **실제로 검색해서
 *    주소창을 복사한 형식**만 넣는다.
 *
 * ⚠️ **가격은 이 날짜로 조사한 값이 아니다.** 1차 검색은 날짜 없이 일반 요금대를
 *    훑으므로, 링크를 열면 카드의 숫자와 다를 수 있다. 그 사실을 카드 아래 고지에
 *    반드시 적어야 한다 (cards.noticeText).
 */

import { TripType } from './flight.types';

/**
 * 떠나는 날을 며칠 뒤로 둘지.
 *
 * ⚠️ **오늘이 아니라 내일이다.** 오늘 출발하는 항공권은 대부분 이미 못 사거나
 *    당일 요금이라 비정상적으로 비싸다. 검색 결과 첫 줄이 "오늘 밤 11시 출발
 *    180만원" 이면 카드에 적힌 시세와 너무 벌어져서 링크가 오히려 불신을 준다.
 */
export const DEPART_AFTER_DAYS = 1;

/** 돌아오는 날을 **떠나는 날로부터** 며칠 뒤로 둘지. 왕복 검색에만 쓴다. */
export const RETURN_AFTER_DAYS = 7;

/**
 * 날짜의 기준 시간대. **서버가 UTC 로 돌아도 사용자의 "오늘" 이어야 한다.**
 *
 * UTC 서버에서 `new Date()` 를 그대로 쓰면 한국 시간 09:00 이전에는 전날이 나온다.
 * 새벽에 물어본 사람에게 어제 출발하는 항공권을 검색해 주는 셈이다.
 */
const TZ = 'Asia/Seoul';

/** 그 시간대 기준의 `YYYY-MM-DD`. */
export function seoulDate(base: Date, plusDays = 0): string {
  const shifted = new Date(base.getTime() + plusDays * 86_400_000);
  // en-CA 로케일이 YYYY-MM-DD 를 준다. 직접 조립하면 자릿수 padding 을 빠뜨린다.
  return shifted.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** 스카이스캐너 경로에 쓰는 `YYMMDD`. */
function compact(isoDate: string): string {
  return isoDate.slice(2).replace(/-/g, '');
}

/**
 * 발화에서 읽은 여행 조건. **읽지 못한 칸은 null 이다** — 기본값은 `resolveTrip` 이
 * 한 번만 채운다.
 */
export interface TripParams {
  /** 가는 날 `YYYY-MM-DD`. */
  departDate: string | null;
  /** 오는 날 `YYYY-MM-DD`. 왕복인데 안 말했으면 null 이고 기본값이 채운다. */
  returnDate: string | null;
  /** '3박' 의 3. 귀국일을 안 말했을 때 출발일에서 이만큼 뒤로 민다. */
  nights: number | null;
  /** 어른 수. 플랫폼 파라미터가 1~9 라 그 범위만 읽는다. */
  adults: number | null;
  /** 반영한 표현 그대로. "반영하지 않았어요" 고지에서 빼는 데 쓴다. */
  used: string[];
}

/** 실제로 링크에 박히는 값. 카드 고지도 **같은 함수**를 보고 적는다. */
export interface ResolvedTrip {
  depart: string;
  /** 편도면 null. */
  back: string | null;
  adults: number;
}

/**
 * 못 읽은 칸을 기본값으로 채운다.
 *
 * ⚠️ **기본값이 사는 유일한 곳이다.** 링크를 만드는 쪽과 고지를 적는 쪽이 각자
 *    채우면 "내일 출발로 검색됩니다" 라고 적어놓고 다른 날짜로 여는 카드가 나온다.
 */
export function resolveTrip(
  tripType: TripType,
  trip: TripParams | null | undefined,
  now: Date,
): ResolvedTrip {
  const depart = trip?.departDate ?? seoulDate(now, DEPART_AFTER_DAYS);
  // 귀국일은 **출발일로부터** 센다. 오늘로부터 세면 "다음 달 10일 출발" 이 이미
  // 지난 날짜로 돌아오는 일정이 된다.
  const back =
    tripType === 'round'
      ? (trip?.returnDate ?? addDays(depart, trip?.nights ?? RETURN_AFTER_DAYS))
      : null;
  return { depart, back, adults: trip?.adults ?? 1 };
}

/** ISO 날짜에 며칠 더하기. 서울 기준으로 뽑힌 문자열이라 산술만 하면 된다. */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface FlightRoute {
  /** 출발 공항 IATA (ICN). */
  originCode: string;
  /** 도착 공항 IATA (KIX). */
  destCode: string;
  /**
   * ⚠️ **항공권 도메인의 TripType 이다** (`'round' | 'oneway'`). 검색 쪽에도 같은
   *    이름의 타입이 있는데 값이 `'rt' | 'ow'` 로 다르다 — 섞으면 왕복을 편도로 연다.
   */
  tripType: TripType;
  /** 어느 제휴몰의 주소인가 (trip | skyscanner | myrealtrip …). */
  merchant?: string | null;
  /** 화면 라벨용 도시명 (서울 · 오사카). 마이리얼트립만 쓰고, 없어도 검색은 된다. */
  originName?: string | null;
  destName?: string | null;
}

/**
 * 검색된 상태의 주소. 형식을 모르는 제휴몰이면 null.
 *
 * @param now  기준 시각. 테스트가 고정값을 넣는다.
 * @param trip 발화에서 읽은 날짜·인원. 없으면 기본값으로 연다.
 */
export function datedSearchUrl(
  route: FlightRoute,
  now: Date = new Date(),
  trip?: TripParams | null,
): string | null {
  const from = (route.originCode ?? '').trim().toLowerCase();
  const to = (route.destCode ?? '').trim().toLowerCase();
  // 공항 코드가 없으면 노선을 특정할 수 없다. 원본 주소가 그나마 맞다.
  if (!/^[a-z]{3}$/.test(from) || !/^[a-z]{3}$/.test(to)) return null;

  const { depart, back, adults } = resolveTrip(route.tripType, trip, now);
  const roundTrip = route.tripType === 'round';

  switch (route.merchant) {
    case 'skyscanner': {
      // 날짜가 경로에 들어간다. 편도는 두 번째 날짜 칸을 아예 빼야 한다.
      const path = [from, to, compact(depart), back && compact(back)].filter(Boolean).join('/');
      const params = new URLSearchParams({
        adults: String(adults),
        cabinclass: 'economy',
        currency: 'KRW',
      });
      return `https://www.skyscanner.co.kr/transport/flights/${path}/?${params}`;
    }
    case 'trip': {
      const params = new URLSearchParams({
        dcity: from,
        acity: to,
        ddate: depart,
        triptype: roundTrip ? 'rt' : 'ow',
        class: 'ys',
        quantity: String(adults),
        locale: 'ko-KR',
        curr: 'KRW',
      });
      // ⚠️ 편도에 rdate 를 비워서라도 넣으면 왕복 폼이 열린다. 키 자체를 빼야 한다.
      if (back) params.set('rdate', back);
      return `https://kr.trip.com/flights/showfarefirst?${params}`;
    }
    case 'myrealtrip': {
      // 구간을 `/` 로 잇는다. 한 구간이 `{출발종류}.{코드}.{도착종류}.{코드}.{날짜}` 이고
      // `A` 가 공항, `C` 가 도시다. 사이트가 만드는 주소는 도착지를 도시로 쓰기도
      // 하는데(`A.ICN.C.OSA`), 우리는 IATA **공항** 코드만 들고 있으므로 전부 `A` 다.
      // 둘 다 결과가 뜨는 것을 확인했다. 왕복은 두 번째 구간이 역방향이다.
      const up = (code: string) => code.toUpperCase();
      const legs = [`A.${up(from)}.A.${up(to)}.${depart}`];
      if (back) legs.push(`A.${up(to)}.A.${up(from)}.${back}`);

      const params = new URLSearchParams({
        trip: legs.join('/'),
        adult: String(adults),
        cabins: 'ECONOMY',
        tripType: roundTrip ? 'ROUND_TRIP' : 'ONE_WAY',
        useProgressUi: 'false',
      });
      // 화면에 찍는 라벨이라 없어도 검색은 된다. 있으면 "서울, 오사카" 로 보인다.
      const names = [route.originName, route.destName].filter(Boolean);
      if (names.length === 2) params.set('cityNames', names.join(','));

      return `https://air-web.myrealtrip.com/results?${params}`;
    }
    default:
      // 형식을 확인한 적 없는 제휴몰. 지어내지 않는다.
      return null;
  }
}

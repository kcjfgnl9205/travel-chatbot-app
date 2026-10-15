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
  const fallbackBack = addDays(depart, trip?.nights ?? RETURN_AFTER_DAYS);
  let back = tripType === 'round' ? (trip?.returnDate ?? fallbackBack) : null;
  // ⚠️ **거꾸로 된 일정은 링크에 넣지 않는다.** 파서가 두 날짜를 잘못 읽으면
  //    (실제로 "다음주 수요일~금요일" 이 그랬다) 플랫폼은 귀국일이 앞선 폼을 열고
  //    사용자는 고치는 대신 창을 닫는다. 못 읽은 것으로 보고 기본값으로 돌린다.
  // 같은 날은 정상이다 — 당일치기(nights=0)가 그 자리다. 앞선 날짜만 되돌린다.
  if (back && back < depart) back = fallbackBack;
  return { depart, back, adults: trip?.adults ?? 1 };
}

/** ISO 날짜에 며칠 더하기. 서울 기준으로 뽑힌 문자열이라 산술만 하면 된다. */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 공항 코드 → **트립닷컴이 받는 도시 코드**.
 *
 * ⚠️ **트립닷컴의 `dcity`/`acity` 는 공항이 아니라 도시다.** 공항 코드를 넣으면
 *    못 알아듣고 **엉뚱한 노선을 연다** — "도쿄 항공권" 을 눌렀는데 부산행이 떴다.
 *    조용히 틀리기 때문에 사람이 눌러보기 전엔 아무도 모른다.
 *
 *    부산(PUS)·하노이(HAN)·제주(CJU) 처럼 **공항 코드와 도시 코드가 같은 곳은
 *    우연히 맞았고**, 그래서 한동안 멀쩡해 보였다. 서울(SEL)·도쿄(TYO)·오사카(OSA)
 *    처럼 다른 곳만 깨졌는데 하필 그게 제일 많이 묻는 노선이다.
 *
 * 그래서 **다른 것만** 적는다. 표에 없으면 공항 코드를 그대로 쓴다 — 대부분의
 * 도시가 그 경우이고, 모르는 코드를 지어내는 것보다 낫다.
 *
 * ⚠️ **사전에 없어 모델 경로로 등록된 다중공항 도시는 여전히 깨진다.** 표에 없으니
 *    공항 코드가 그대로 나가기 때문이다. 그런 신고가 들어오면 여기 한 줄 추가한다.
 *
 * ⚠️ 트립닷컴은 `dairport`/`aairport` 로 공항까지 좁힐 수 있는데, 그때 같이 붙는
 *    `dcityid`(내부 번호)를 우리가 만들 수 없어서 쓰지 않는다. 도시 단위로 열면
 *    그 도시의 공항이 전부 보이므로 손해도 아니다 — 김포/인천이 같이 나온다.
 */
const TRIP_CITY_CODES: Record<string, string> = {
  icn: 'sel', // 서울·인천
  gmp: 'sel',
  nrt: 'tyo', // 도쿄
  hnd: 'tyo', // 요코하마도 도쿄권이다
  kix: 'osa', // 오사카·교토
  ukb: 'osa', // 고베
  cts: 'spk', // 삿포로·치토세
  pvg: 'sha', // 상하이
  pek: 'bjs', // 베이징
  cdg: 'par', // 파리
  lhr: 'lon', // 런던
  fco: 'rom', // 로마
  mxp: 'mil', // 밀라노
  arn: 'sto', // 스톡홀름
  svo: 'mow', // 모스크바
  cgk: 'jkt', // 자카르타
  jfk: 'nyc', // 뉴욕
  ord: 'chi', // 시카고
  iad: 'was', // 워싱턴
  yyz: 'yto', // 토론토
  eze: 'bue', // 부에노스아이레스
};

/** 트립닷컴에 넘길 코드. 표에 없으면 공항 코드가 곧 도시 코드다. */
export function tripCityCode(airport: string): string {
  return TRIP_CITY_CODES[airport] ?? airport;
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
      // ⚠️ **인원은 `adults` 가 아니라 `adultsv2` 다.** `adults=4` 로 보냈더니 화면은
      //    1명으로 열렸다 — 모르는 파라미터라 조용히 무시된 것이다. 틀린 인원으로
      //    검색된 페이지는 빈 폼보다 나쁘다. 4명이 예약하려다 가격이 달라서야 안다.
      //    아래 형식은 실제 검색 후 주소창에서 복사한 것이다. 지어내지 않는다.
      const params = new URLSearchParams({
        adultsv2: String(adults),
        cabinclass: 'economy',
        childrenv2: '',
        ref: 'home',
        // 경로의 날짜 칸으로도 왕복이 갈리지만, 사이트가 실제로 붙이는 값이라 같이 준다.
        rtn: roundTrip ? '1' : '0',
        preferdirects: 'false',
        outboundaltsenabled: 'false',
        inboundaltsenabled: 'false',
      });
      // `currency` 는 사이트가 붙이지 않는다. .co.kr 도메인이 원화를 정한다.
      return `https://www.skyscanner.co.kr/transport/flights/${path}/?${params}`;
    }
    case 'trip': {
      // ⚠️ **`quantity` 만으로는 인원이 안 먹었다.** 이름은 맞는데 화면이 1명으로
      //    열렸다 — 사이트가 실제로 붙이는 `searchboxarg=t`(검색 폼에서 온 요청이다)
      //    가 없으면 인원을 무시하는 것으로 보인다. 아래는 실제 주소창에서 복사한
      //    형식 그대로다. 한 칸이라도 빼면 또 조용히 1명이 될 수 있다.
      const params = new URLSearchParams({
        // ⚠️ **공항이 아니라 도시 코드다.** 공항 코드를 넣으면 엉뚱한 노선이 열린다.
        dcity: tripCityCode(from),
        acity: tripCityCode(to),
        ddate: depart,
        triptype: roundTrip ? 'rt' : 'ow',
        class: 'ys',
        lowpricesource: 'searchform',
        quantity: String(adults),
        searchboxarg: 't',
        nonstoponly: 'off',
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

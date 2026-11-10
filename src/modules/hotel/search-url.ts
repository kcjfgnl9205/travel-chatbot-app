import { hostMatches } from '../../common/booking-url';
import { TripDateProblem, TripParams, seoulDate } from '../flight/search-url';
import { isKorea } from '../places/city-table';

/**
 * 호텔 **검색 결과** 주소를 만든다. 항공권의 [search-url.ts](../flight/search-url.ts)
 * 와 같은 일을 호텔에서 한다.
 *
 * 왜 필요한가 — 모델이 주는 건 호텔 하나의 예약 페이지이고, **그게 죽어 있거나
 * 엉뚱한 곳으로 가면 사용자에게 줄 것이 없다.** 실제로 "추천한 호텔이 아닌 다른 지역이
 * 나오거나, 결과가 없거나, 홈으로 이동" 하는 신고가 들어왔다. 그때 "정리하지 못했어요"
 * 로 끝내는 대신 **그 지역 호텔 검색 결과**를 열어준다.
 *
 * 덤으로 **날짜·인원이 반영된다.** 검색 캐시는 지역으로만 가르기 때문에 AI 목록에는
 * 날짜를 못 넣지만([hotel.service.ts](./hotel.service.ts) `queryOf`), 이 주소에는
 * 넣을 수 있다 — 항공권이 같은 이유로 같은 길을 갔다.
 *
 * ⚠️ **형식을 아는 제휴몰만 만든다.** 아래 둘은 **실제로 검색해 주소창에서 복사한
 *    형식**이고, 군더더기를 덜어낸 뒤에도 동작하는 것을 확인했다(2026-11-02).
 *    지어낸 주소로 보내는 것은 아무것도 안 주는 것보다 나쁘다.
 *
 * ⚠️ **클룩·트립닷컴은 여기 없다.** 둘 다 지역을 **내부 숫자 ID** 로 받는다
 *    (`city_id=29`, `city=219` + `searchValue=19|219*19*219*1`). 우리는 한국어
 *    지명만 들고 있어서 그 번호를 만들 수 없다 — 항공권이 트립닷컴 `dairport` 를
 *    못 쓰는 것과 **똑같은 이유**다(`dcityid` 를 만들 수 없다). 도시 ID 대조표를
 *    채우면 그때 늘린다. 세부 지역(해운대·신주쿠)까지는 그래도 어렵다.
 *
 * ⚠️ **저장하면 안 된다. 카드를 그릴 때마다 만든다.** 주소에 날짜가 박히는데
 *    `search_results` 는 날짜를 캐시 키에 안 넣고 하루를 산다 — 구워서 저장하면
 *    내일 캐시를 맞은 사람이 어제 날짜로 검색된 페이지를 받는다 (0004 와 같은 이유).
 */

/** 묵는 조건. 못 읽은 칸은 null 이고, 기본값은 [resolveStay] 한 곳에서만 채운다. */
export interface HotelStay {
  /** 체크인 `YYYY-MM-DD`. */
  checkIn: string | null;
  /** 체크아웃 `YYYY-MM-DD`. */
  checkOut: string | null;
  /** '2박' 의 2. 체크아웃을 안 말했을 때 체크인에서 이만큼 뒤로 민다. */
  nights: number | null;
  /** 어른 수. */
  adults: number | null;
}

/** 실제로 주소에 박히는 값. */
export interface ResolvedStay {
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  /**
   * 말한 인원이 상한을 넘어 **우리가 줄였는가.** 넘었으면 카드에 적어야 한다 —
   * 8명이라고 말한 사람에게 6명짜리 링크를 말없이 주면 그 사람은 8명으로 검색된
   * 줄 알고 예약하러 간다.
   */
  adultsClamped: boolean;
}

/**
 * 체크인을 며칠 뒤로 둘지. **오늘이 아니라 내일이다** — 당일 예약은 선택지가 거의
 * 없고 요금도 비정상적이라, 열어봐야 "이 지역엔 호텔이 없나" 로 읽힌다.
 */
export const CHECKIN_AFTER_DAYS = 1;

/** 체크아웃을 체크인으로부터 며칠 뒤로 둘지. */
export const DEFAULT_NIGHTS = 1;

/** 인원을 안 말했을 때. 2인 1실이 가장 흔한 숙박이다. */
export const DEFAULT_ADULTS = 2;

/**
 * 한 방에 넣을 수 있는 최대 인원. **6명에서 끊는다.**
 *
 * 그 위는 제휴몰마다 객실을 나누라고 요구하는데(2+2+2 식), 우리는 방을 몇 개로
 * 쪼갤지 알 수 없다. 억지로 한 방 7명을 보내면 폼이 빈 결과를 열거나 조용히
 * 기본값으로 돌아간다 — **몇 명으로 열리는지 사용자가 모르게 되는 쪽**이 가장 나쁘다.
 *
 * 그래서 6명으로 맞추고, **맞췄다는 사실을 카드에 적는다**(`adultsClamped`).
 */
export const MAX_ADULTS = 6;

/**
 * 못 읽은 칸을 기본값으로 채운다. **기본값이 사는 유일한 곳이다** — 주소를 만드는
 * 쪽과 고지를 적는 쪽이 각자 채우면 적어놓은 날짜와 열리는 날짜가 갈린다.
 */
export function resolveStay(stay: HotelStay | null | undefined, now: Date): ResolvedStay {
  const checkIn = stay?.checkIn ?? seoulDate(now, CHECKIN_AFTER_DAYS);
  // 체크아웃은 **체크인으로부터** 센다. 오늘로부터 세면 "다음 달 10일 체크인" 이
  // 이미 지난 날짜에 나오는 일정이 된다.
  const fallbackOut = addDays(checkIn, stay?.nights ?? DEFAULT_NIGHTS);
  let checkOut = stay?.checkOut ?? fallbackOut;
  // 거꾸로 선 일정은 폼을 못 연다. 못 읽은 것으로 보고 기본값으로 돌린다.
  // ⚠️ 같은 날도 안 된다 — 호텔은 **1박 이상**이어야 검색이 된다(항공권과 다르다).
  if (checkOut <= checkIn) checkOut = fallbackOut;
  const { adults, adultsClamped } = clampAdults(stay?.adults);
  return { checkIn, checkOut, adults, rooms: 1, adultsClamped };
}

/** 6명을 넘으면 6명으로 맞춘다. **줄였다는 사실을 같이 돌려준다** — 고지가 그걸 읽는다. */
function clampAdults(asked: number | null | undefined): { adults: number; adultsClamped: boolean } {
  if (!asked || asked < 1) return { adults: DEFAULT_ADULTS, adultsClamped: false };
  return { adults: Math.min(asked, MAX_ADULTS), adultsClamped: asked > MAX_ADULTS };
}

/** 검색 주소 형식을 확인한 제휴몰. */
export type SearchMerchant = 'hotels' | 'myrealtrip';

/**
 * 검색 링크 카드(⑥)에 내놓는 제휴몰. **순서가 카드 줄 순서다.**
 *
 * ⚠️ **마이리얼트립은 뺐다.** 제휴 링크가 「서비스 정책에 의해 링크 연결이 차단」으로
 *    막혔다(2026-11-09). 주소 형식은 확인해둔 것이라 `hotelSearchUrl` 에는 남겨둔다 —
 *    풀리면 여기에 다시 넣기만 하면 된다.
 */
export const SEARCH_MERCHANTS: readonly SearchMerchant[] = ['hotels'];

/** 화면에 적을 제휴몰 이름. */
export const MERCHANT_LABEL: Record<SearchMerchant, string> = {
  hotels: '호텔스닷컴',
  myrealtrip: '마이리얼트립',
};

export interface HotelSearchQuery {
  /** 사용자가 말한 지역 그대로 ("오사카", "해운대"). 이름으로 검색된다. */
  placeName: string;
  /** 국내인지 가리는 데만 쓴다. 모르면 null. */
  countryCode?: string | null;
  stay?: HotelStay | null;
}

/**
 * 검색된 상태의 주소. 형식을 모르는 제휴몰이면 null.
 *
 * @param now 기준 시각. 테스트가 고정값을 넣는다.
 */
export function hotelSearchUrl(
  /** 형식을 모르는 이름이 와도 된다 — 그때는 null 이다. 지어내지 않는다. */
  merchant: string,
  query: HotelSearchQuery,
  now: Date = new Date(),
): string | null {
  const place = query.placeName?.trim();
  if (!place) return null;

  const { checkIn, checkOut, adults, rooms } = resolveStay(query.stay, now);

  switch (merchant) {
    case 'hotels': {
      // ⚠️ **지역을 이름 그대로 받는다.** 내부 ID 가 필요 없어서 세부 지역도 그대로
      //    들어간다 (`destination=해운대` 로 결과가 나오는 것을 확인했다).
      //
      // ⚠️ 주소창에는 `typeaheadCollationId`(타이프어헤드 세션 GUID)가 같이 붙어
      //    있었는데 **우리가 만들 수 없는 값**이다. 빼고도 검색이 되는 것을 확인했다.
      //
      // `d1`/`d2` 는 `startDate`/`endDate` 와 같은 값이다. 사이트가 둘 다 붙이므로
      // 같이 보낸다 — 항공권에서 한 칸을 뺐다가 인원이 조용히 1명으로 열린 적이 있다.
      const params = new URLSearchParams({
        destination: place,
        d1: checkIn,
        startDate: checkIn,
        d2: checkOut,
        endDate: checkOut,
        adults: String(adults),
        rooms: String(rooms),
      });
      return `https://kr.hotels.com/Hotel-Search?${params}`;
    }
    case 'myrealtrip': {
      // ⚠️ 주소창에는 `regionId` 가 같이 붙어 있었는데 그것도 내부 번호다.
      //    `keyword` 단독으로 검색이 되는 것을 확인했다.
      const params = new URLSearchParams({
        keyword: place,
        checkIn,
        checkOut,
        adultCount: String(adults),
        childCount: '0',
        roomCount: String(rooms),
        // 국내/해외 탭이 갈린다. 모르면 해외로 둔다 — 국내 지명은 사전이 들고 있다.
        isDomestic: String(isKorea(place, query.countryCode ?? null)),
      });
      return `https://accommodation.myrealtrip.com/union/products?${params}`;
    }
    default:
      // 형식을 확인한 적 없는 제휴몰. 지어내지 않는다.
      return null;
  }
}

/** 만들 수 있는 모든 제휴몰의 검색 주소. 카드 줄 순서 그대로다. */
export function hotelSearchUrls(
  query: HotelSearchQuery,
  now: Date = new Date(),
): { merchant: SearchMerchant; label: string; url: string }[] {
  const out: { merchant: SearchMerchant; label: string; url: string }[] = [];
  for (const merchant of SEARCH_MERCHANTS) {
    const url = hotelSearchUrl(merchant, query, now);
    if (url) out.push({ merchant, label: MERCHANT_LABEL[merchant], url });
  }
  return out;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 발화에서 읽은 날짜·인원([TripParams](../flight/search-url.ts))을 숙박 조건으로.
 *
 * 같은 파서를 쓴다 — "11월 20일 체크인 11월 23일 체크아웃" 도 "11월 20일 출발
 * 11월 23일 귀국" 과 똑같이 **앞이 시작, 뒤가 끝**이라 가를 이유가 없다. 파서를
 * 하나 더 만들면 호텔과 항공권이 같은 문장을 다르게 읽기 시작한다.
 */
export function stayOf(trip: TripParams | null | undefined): HotelStay | null {
  if (!trip) return null;
  return {
    checkIn: trip.departDate,
    checkOut: trip.returnDate,
    nights: trip.nights,
    adults: trip.adults,
  };
}

// ------------------------------------------------------------ 되물어야 하는 날짜
/**
 * 호텔에서 되물어야 하는 날짜 문제.
 *
 * 항공권의 둘([TripDateProblem](../flight/search-url.ts))에 **호텔에만 있는 하나**를
 * 더한다 — 체크인과 체크아웃이 같은 날이면 0박이라 **검색 자체가 안 된다.**
 * 항공권에서 같은 날은 당일치기라 멀쩡한 일정이고, 그래서 이 판정을 공유할 수 없다.
 */
export type StayDateProblem = TripDateProblem | { kind: 'same-day'; date: string };

/**
 * 고쳐서는 안 되는 날짜인가. 없으면 null 이고 평소대로 간다.
 *
 * ⚠️ **둘 다 사용자가 콕 집어 말한 날짜일 때만 문제로 삼는다.** "다음 주말" 을
 *    파서가 한 날로 읽은 것까지 되물으면, 사용자는 자기가 말한 적 없는 날짜에 대해
 *    질문을 받는다 — 항공권이 같은 규칙을 쓴다.
 */
export function stayProblem(trip: TripParams | null | undefined): StayDateProblem | null {
  if (!trip) return null;
  // 지난 날짜·역순은 항공권과 판정이 같다. 한 번 더 세지 않는다.
  if (trip.problem) return trip.problem;
  if (
    trip.departDate &&
    trip.departDate === trip.returnDate &&
    trip.explicit?.depart &&
    trip.explicit?.return
  ) {
    return { kind: 'same-day', date: trip.departDate };
  }
  return null;
}

// ------------------------------------------------------------ 상세 페이지 조건
/**
 * **호텔 한 곳의 상세 페이지**에 날짜·인원을 박는다.
 *
 * 왜 필요한가 — 모델이 주는 주소는 조건이 없는 맨 상세 페이지라, 열면 사용자가
 * 날짜·인원을 다시 입력해야 한다. 그 한 단계가 이탈 지점이다(항공권이 같은 이유로
 * 검색된 상태를 연다).
 *
 * ⚠️ **형식을 확인한 제휴몰만 바꾼다. 모르면 원본 그대로 돌려준다.** 파라미터
 *    이름은 사이트마다 다르고 문서화돼 있지도 않다. 지어낸 이름을 붙이면 둘 중
 *    하나인데 **둘 다 맨 페이지보다 나쁘다** — 사이트가 무시하면 카드에 적은 날짜와
 *    열리는 날짜가 갈리고, 잘못 해석하면 말한 적 없는 날짜로 열린다.
 *
 * ⚠️ **저장하면 안 된다. 카드를 그릴 때마다 만든다.** 검색 캐시는 날짜를 키에 안
 *    넣고 하루를 산다 — 구워서 저장하면 내일 캐시를 맞은 사람이 어제 날짜로 열린다
 *    (`hotelSearchUrl` 과 같은 이유, 0004).
 *
 * ⚠️ **조건이 붙은 주소가 곧 애드픽 변환 키다**([affiliate.service.ts](../affiliate/affiliate.service.ts)).
 *    날짜가 바뀌면 커미션 링크도 새로 만들어진다. 기본값으로 여는 사람은 하루 동안
 *    같은 키라 캐시를 맞지만, 날짜를 직접 말한 사람의 첫 클릭은 변환을 기다린다.
 *    **추적 코드(`p_data`)까지 갈리지는 않는다** — `withoutStay` 가 그걸 막는다.
 */
export function withStay(
  url: string,
  stay: HotelStay | null | undefined,
  now: Date = new Date(),
): string {
  const params = writerFor(url);
  if (!params) return url;
  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params(resolveStay(stay, now)))) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    // 주소가 아니면 손대지 않는다. 호출부는 원본을 그대로 쓴다.
    return url;
  }
}

/**
 * `withStay` 가 붙인 칸을 도로 뗀다. **호텔 한 곳의 신원이 되는 주소다.**
 *
 * 애드픽 추적 코드(`p_data` = `sha1(주소)`)가 이걸 보고 만들어진다. 조건이 붙은
 * 주소로 만들면 **같은 호텔이 날짜마다 다른 코드**를 받아서, 애드픽 성과 화면에서
 * 한 호텔이 수십 줄로 쪼개진다 — 전환은 드물어서 쪼개면 한 줄에 0 아니면 1 이 찍히고
 * 아무것도 못 읽는다. 날짜별로 보고 싶으면 우리 `recommendation_items.source_url`
 * 에 조건이 그대로 남아 있다.
 *
 * ⚠️ **우리가 붙인 칸만 뗀다.** 같은 이름이라도 모르는 주소 꼴이면 손대지 않는다 —
 *    예컨대 `adult` 는 마이리얼트립 **항공권** 검색 주소에도 있는 칸이라, 호스트와
 *    경로까지 맞을 때만 떼야 항공권 추적이 같이 뭉개지지 않는다.
 */
export function withoutStay(url: string): string {
  const params = writerFor(url);
  if (!params) return url;
  try {
    const parsed = new URL(url);
    // 값은 필요 없고 **칸 이름만** 필요하다. 쓰는 쪽과 떼는 쪽이 같은 표를 보므로
    // 한쪽만 고쳐서 어긋날 일이 없다.
    for (const key of Object.keys(params(SAMPLE_STAY))) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 칸 이름을 뽑으려고 쓰는 값. 어떤 주소에도 안 들어간다. */
const SAMPLE_STAY: ResolvedStay = {
  checkIn: '',
  checkOut: '',
  adults: 1,
  rooms: 1,
  adultsClamped: false,
};

/** 이 주소에 조건을 **박을 수 있는가.** 박은 것이 사용자에게 가는지는 별개다(아래). */
export function staySupported(url: string): boolean {
  return writerFor(url) !== null;
}

/**
 * **애드픽을 거치면 숙박 조건이 사라지는 제휴몰.**
 *
 * 주소에는 멀쩡히 붙고 브라우저로 직접 열면 반영되는데, **애드픽 → 제휴 네트워크
 * 경유에서 쿼리가 통째로 날아간다.** 호텔스닷컴(Partnerize)에서 확인했다
 * (2026-11-09, [ISSUE 문서](../../../docs/ISSUE-2026-11-09-HOTELS-COM-STAY.md)).
 * 애드픽에서 직접 만든 링크도 같아서 **우리 코드로는 못 고친다.**
 *
 * ⚠️ 그래도 주소에는 계속 붙인다. 애드픽 변환이 실패하면 리다이렉트가 **원본 주소로**
 *    보내는데([redirect.controller.ts](../redirect/redirect.controller.ts)), 그때는
 *    조건이 그대로 살아서 간다. 붙이는 데 드는 비용도 없다.
 */
export const STAY_DROPPED_BY_AFFILIATE = ['hotels.com'];

/**
 * **사용자가 실제로 그 조건으로 열게 되는가.** 카드 고지는 이걸 보고 말을 고른다.
 *
 * `staySupported` 와 갈라놓은 이유 — 조건을 붙일 수 있다는 것과 그게 사용자에게
 * 닿는다는 것은 다른 말이다. 둘을 같은 것으로 보고 고지를 적었더니 **「링크는 12월 2일
 * 체크인 … 으로 열려요」라고 적어놓고 날짜가 빈 페이지를 여는** 카드가 나갔다. 사용자는
 * 그 안내를 믿고 예약하러 간다 — 아무 말 안 하는 것보다 나쁘다.
 */
export function stayReachesUser(url: string): boolean {
  if (!staySupported(url)) return false;
  try {
    const host = new URL(url).hostname;
    return !STAY_DROPPED_BY_AFFILIATE.some((domain) => hostMatches(host, domain));
  } catch {
    return false;
  }
}

/** 조건 → 주소에 박을 칸. **이 표 하나가 쓰기와 떼기를 다 정한다.** */
type StayWriter = (stay: ResolvedStay) => Record<string, string>;

interface DetailFormat {
  domain: string;
  /**
   * **확인한 경로 모양.** 호스트만 보고 붙이지 않는다 — 같은 사이트 안에서도 상세
   * 주소가 여러 꼴이고(`/hotels/detail/` vs `/hotels/{도시}-hotel-detail-{번호}/`),
   * 확인하지 않은 꼴에서 파라미터가 무시되면 **카드에 적은 날짜와 열리는 날짜가
   * 갈린다.** 그건 맨 주소로 여는 것보다 나쁘다.
   */
  path: RegExp;
  params: StayWriter;
}

/**
 * 제휴몰별 상세 페이지 파라미터.
 *
 * ⚠️ **전부 실제 상세 페이지에서 날짜·인원을 넣고 주소창을 복사한 것이다**
 *    (2026-11-09). 검색 결과 주소(`hotelSearchUrl`)가 2026-11-02 에 같은 방법으로
 *    확인된 것과 같은 규칙이다 — **지어낸 파라미터는 넣지 않는다.**
 *
 *    우리가 만들 수 없는 값은 덜어냈다: 추적 토큰(`pwa_ts`·`searchId`·
 *    `source_price_token`·`serverData`·`hoteluniquekey`), 내부 번호(`regionId`·
 *    `neighborhoodId`·`expediaPropertyId`), 그리고 그 호텔 주소가 이미 들고 있는
 *    것(`hotelId`·`cityId`).
 *
 * ⚠️ **방은 늘 하나다**(`stay.rooms`). 인원을 6명에서 끊는 이유이기도 하다 — 그
 *    위는 사이트가 객실을 나누라고 요구하는데 몇 개로 쪼갤지 우리가 모른다.
 */
/**
 * 트립닷컴이 받는 칸. **주소 꼴 둘이 같은 칸을 쓴다** — 함수를 하나만 두어, 한쪽만
 * 고쳐서 두 꼴이 다르게 열리는 일이 없게 한다.
 */
const TRIP_STAY_PARAMS: StayWriter = (stay) => ({
  checkIn: stay.checkIn,
  checkOut: stay.checkOut,
  adult: String(stay.adults),
  // 아이 수·객실 수도 같이 붙어 있었다. 한 칸을 빼면 조용히 기본값이 될 수 있다
  // (항공권에서 한 칸을 뺐다가 인원이 1명으로 열린 적이 있다).
  children: '0',
  crn: String(stay.rooms),
});

const DETAIL_FORMATS: DetailFormat[] = [
  {
    // kr.hotels.com/ho1948759872/hotel-intergate-osaka-umeda-osaka-ilbon/
    domain: 'hotels.com',
    path: /^\/ho\d+\//,
    params: (stay) => ({
      chkin: stay.checkIn,
      chkout: stay.checkOut,
      // ⚠️ **인원은 객실별로 적는다.** `rm1=a3` 이 "1번 방 성인 3명" 이다.
      //    `adults=3` 은 검색 결과 주소의 칸이고, 상세에는 이 꼴로 붙어 있었다.
      rm1: `a${stay.adults}`,
    }),
  },
  {
    // kr.trip.com/hotels/detail/?cityId=248&hotelId=49507812&checkIn=...
    domain: 'trip.com',
    path: /^\/hotels\/detail\/?$/,
    params: TRIP_STAY_PARAMS,
  },
  {
    // kr.trip.com/hotels/fukuoka-hotel-detail-688242/ · …/688242/호텔이름
    //
    // ⚠️ **같은 사이트인데 주소 꼴이 둘이고, 받는 칸은 같다**(2026-11-10 확인).
    //    한동안 이 꼴에는 조건을 안 붙였는데, 모델이 검색 결과에서 가져오는 주소는
    //    주로 이 꼴이라 **카드가 통째로 날짜를 말하지 못했다**(한 줄이라도 조건이
    //    안 닿으면 고지에서 빠진다). 후쿠오카가 그래서 「반영되지 않았어요」였다.
    //
    // ⚠️ **주소를 `?hotelId=` 꼴로 고쳐 쓰지 않는다.** 출처 대조(`verify.ts` urlKey)는
    //    두 꼴을 다른 페이지로 보기 때문에, 바꿔 적으면 "검색 결과에 없는 주소" 가
    //    되어 그 호텔이 통째로 버려진다. 꼴은 그대로 두고 칸만 붙인다.
    domain: 'trip.com',
    path: /^\/hotels\/[^/]*-detail-\d+(?:\/[^/]*)?\/?$/i,
    params: TRIP_STAY_PARAMS,
  },
  {
    // www.klook.com/ko/hotels/detail/1134329-prince-smart-inn-osaka-yodoyabashi/
    domain: 'klook.com',
    path: /^\/[a-z]{2}(?:-[a-zA-Z]{2,4})?\/hotels\/detail\//,
    params: (stay) => ({
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      adult_num: String(stay.adults),
      child_num: '0',
      room_num: String(stay.rooms),
    }),
  },
  {
    // accommodation.myrealtrip.com/union/products/5007313
    //
    // ⚠️ **`www.myrealtrip.com/offers/...` 는 여기 없다.** 모델이 그 꼴도 주는데,
    //    오퍼 페이지에서도 같은 칸이 먹는지 확인한 적이 없다.
    domain: 'myrealtrip.com',
    path: /^\/union\/products\/\d+/,
    params: (stay) => ({
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      adultCount: String(stay.adults),
      childCount: '0',
      // ⚠️ `isDomestic` 은 **건드리지 않는다.** 주소창에 같이 있었지만 그 상품이
      //    국내인지는 상품 번호가 이미 정한다. 잘못 넣으면 탭만 틀어진다.
    }),
  },
];

function writerFor(url: string): StayWriter | null {
  try {
    const parsed = new URL(url);
    const format = DETAIL_FORMATS.find(
      (known) => hostMatches(parsed.hostname, known.domain) && known.path.test(parsed.pathname),
    );
    return format?.params ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ 상세 페이지인가
/**
 * **호텔 한 곳의 상세 페이지 주소인가.** 아니면 카드 줄로 쓰지 않는다.
 *
 * 모델은 웹 검색에 잘 걸리는 **도시 목록 페이지**를 자주 준다
 * (`kr.trip.com/hotels/da-nang-hotels-list-1356/`, `klook.com/ko/destination/c74-da-nang/3-hotel/`).
 * 허용 호스트라 그대로 통과했고, 사용자는 호텔을 눌렀는데 **다낭 호텔 목록**에
 * 떨어졌다 (2026-11-09). 이름은 그 호텔인데 열리는 건 검색창이다.
 *
 * ⚠️ **확인한 꼴만 받는다.** 날짜를 박을 수 있는 꼴(`DETAIL_FORMATS`)이 대부분이고,
 *    날짜 칸은 확인 못 했지만 호텔 한 곳을 가리키는 것이 분명한 꼴을 하나 더 받는다 —
 *    마이리얼트립 `/offers/{번호}`. 상세로는 열리고 조건만 안 붙는다(`staySupported`
 *    가 false). 트립닷컴 경로 꼴은 2026-11-10 에 칸이 확인돼 `DETAIL_FORMATS` 로 갔다.
 */
export function isHotelDetailUrl(url: string): boolean {
  if (staySupported(url)) return true;
  try {
    const parsed = new URL(url);
    return EXTRA_DETAIL_PATHS.some(
      (known) => hostMatches(parsed.hostname, known.domain) && known.path.test(parsed.pathname),
    );
  } catch {
    return false;
  }
}

const EXTRA_DETAIL_PATHS: { domain: string; path: RegExp }[] = [
  // www.myrealtrip.com/offers/12345
  { domain: 'myrealtrip.com', path: /^\/offers\/\d+\/?$/ },
];

import { seoulDate } from '../flight/search-url';
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
}

/**
 * 체크인을 며칠 뒤로 둘지. **오늘이 아니라 내일이다** — 당일 예약은 선택지가 거의
 * 없고 요금도 비정상적이라, 열어봐야 "이 지역엔 호텔이 없나" 로 읽힌다.
 */
export const CHECKIN_AFTER_DAYS = 1;

/** 체크아웃을 체크인으로부터 며칠 뒤로 둘지. */
export const DEFAULT_NIGHTS = 1;

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
  return { checkIn, checkOut, adults: clampAdults(stay?.adults), rooms: 1 };
}

/** 플랫폼 파라미터가 1~9 라 그 범위만 보낸다. */
function clampAdults(adults: number | null | undefined): number {
  if (!adults || adults < 1) return 2;
  return Math.min(adults, 9);
}

/** 주소를 만들 수 있는 제휴몰. **순서가 카드 줄 순서다.** */
export const SEARCH_MERCHANTS = ['hotels', 'myrealtrip'] as const;
export type SearchMerchant = (typeof SEARCH_MERCHANTS)[number];

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

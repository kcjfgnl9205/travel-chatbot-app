import { durationText } from '../../common/duration';

/**
 * 편도/왕복.
 *
 * 라우터의 `rt`/`ow` 와 표기가 다르다. 여기 이름은 provider 프롬프트와 카드 문구가
 * 쓰는 값이라 바꾸면 그쪽까지 건드려야 하고, 변환은 한 줄이면 끝난다
 * ([flight.service.ts](./flight.service.ts) queryOf).
 */
export type TripType = 'oneway' | 'round';

/**
 * provider 가 돌려주는 항공권 1건.
 *
 * 호텔(Hotel)과 나란히 두되 필드를 공유하지 않는다. 호텔은 "장소 하나"인데
 * 항공권은 "구간"이라, 억지로 한 타입에 넣으면 양쪽 다 optional 범벅이 된다.
 */
export interface Flight {
  /** 한국어 항공사명. 카드 첫 줄에 나간다. */
  airline: string;
  /** KE723 처럼. 여러 편이 묶인 경우 대표 편명. 모르면 null. */
  flightNo?: string | null;

  originCode: string; // ICN
  originName?: string | null; // 인천
  destCode: string; // KIX
  destName?: string | null; // 오사카

  /**
   * 출발/도착 시각. **HH:MM 문자열이다.**
   *
   * 왜 Date 가 아닌가 — 항공편 시각은 각 공항의 현지 시각이다. Date 로 만들면
   * 시간대를 붙여야 하는데 provider(모델)는 그걸 못 준다. 잘못된 시간대로 변환된
   * 시각을 보여주는 건 시각을 안 보여주는 것보다 나쁘다.
   */
  departTime?: string | null;
  arriveTime?: string | null;
  /** 가는 날 YYYY-MM-DD. 검색 날짜와 같지만 provider 가 다른 날을 줄 수도 있다. */
  departDate?: string | null;

  /** 돌아오는 편 (왕복일 때만). */
  returnDate?: string | null;
  returnDepartTime?: string | null;
  returnArriveTime?: string | null;

  /** 총 소요 시간(분). 편도 기준. */
  durationMinutes?: number | null;
  /** 경유 횟수. 0 이면 직항. */
  stops?: number | null;
  /** 경유지 공항/도시. 직항이면 null. */
  via?: string | null;

  tripType: TripType;
  cabin?: string | null;
  /** 1인 기준 총액(원). 왕복이면 왕복 합계. */
  priceFrom?: number | null;
  currency?: string;

  /**
   * 예약 페이지 주소. 애드픽 변환의 입력이고, 사용자가 실제로 이동하는 곳이다.
   *
   * ⚠️ 호텔과 달리 **여러 항공편이 같은 주소를 가리킬 수 있다** (같은 노선의
   *    검색 결과 페이지). 그래서 항공편의 신원으로는 쓸 수 없다 — dedupeKey 를 쓴다.
   */
  sourceUrl: string;
  merchant?: string | null; // trip | myrealtrip
  source?: string; // ai | crawler | manual
  tags?: string[];
  raw?: Record<string, unknown> | null;
}

/**
 * 카드 한 줄이 되는 값. **편이 아니라 "플랫폼 하나"다.**
 *
 * 예전에는 편별로 한 줄씩 냈는데, 줄마다 다른 편명·시각·가격을 찍으면서
 * **링크는 전부 같은 곳으로 갔다** — 여러 편이 같은 노선 검색 페이지를 가리키기
 * 때문이다. "피치 89,000원" 을 누른 사람이 검색 결과를 보게 되고, 게다가 그
 * 가격은 웹 검색으로 얻은 **예상가이지 확정 운임이 아니다.**
 *
 * 그래서 **모델이 잘하는 것만 남긴다** — 이 노선에 뭐가 다니고 대략 얼마인지.
 * 편별 확정 운임은 플랫폼이 답할 몫이고, 우리는 거기로 정확히 보낸다.
 * 관광지에서 입장료를 아예 안 모으기로 한 것과 같은 판단이다.
 */
export interface FlightOffer {
  /** 이 줄이 보내는 곳. trip | myrealtrip … 카드 제목이 여기서 나온다. */
  merchant: string;
  /** 그 플랫폼의 노선 검색 페이지. **줄의 신원이기도 하다.** */
  sourceUrl: string;
  originCode: string;
  destCode: string;
  originName?: string | null;
  destName?: string | null;
  tripType: TripType;

  /**
   * 대략의 시세. **범위로 말한다.**
   *
   * ⚠️ "122,000원" 은 틀릴 수 있지만 "12~18만원대" 는 맞는다. 모델이 웹에서 본
   *    값들의 폭이라, 확정 운임이 아니라는 사실이 표기 자체에 드러난다.
   */
  priceLow?: number | null;
  priceHigh?: number | null;
  /** 가장 짧은 비행 시간(분). 직항이 있으면 대개 그 값이다. */
  durationMinutes?: number | null;
  /** 직항이 있는 노선인가. 없으면 경유만 있다는 뜻이다. */
  nonstop?: boolean | null;
  /** 이 노선을 다니는 항공사. 카드에 두세 곳만 적는다. */
  airlines?: string[];
}

export interface FlightQuery {
  originSlug: string;
  originName: string;
  originCode: string | null;
  destSlug: string;
  destName: string;
  destCode: string | null;
  tripType: TripType;
  limit: number;
  /**
   * 출발지를 사용자가 말하지 않아서 기본값(서울)으로 채웠는가.
   *
   * 카드에 "서울 출발" 을 적어야 하는지 판단하는 데 쓴다. 사용자가 부산에서
   * 출발하려던 거라면 그 한 줄이 있어야 잘못됐다는 걸 알아챈다.
   */
  originAssumed: boolean;
}

/**
 * 'YYYY-MM-DD' 인지 확인하고 그대로 돌려준다. 아니면 null.
 *
 * ⚠️ 2026-02-30 같은 값은 Date 가 3월 2일로 조용히 굴려버린다. 되돌려 보고 같은지
 *    확인해야 없는 날짜가 카드에 찍히지 않는다.
 */
export function isoDate(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === raw ? raw : null;
}


/**
 * 같은 항공편인지 판정하는 키.
 *
 * sourceUrl 로는 못 한다 — 항공권은 여러 편이 같은 검색 결과 페이지를 가리키므로
 * 그걸로 중복을 지우면 카드가 한 장만 남는다. 편명 + 출발시각이 항공편의 신원이다.
 */
export function flightKey(f: Flight): string {
  return [
    f.flightNo?.toUpperCase() ?? f.airline,
    f.originCode,
    f.destCode,
    f.departDate ?? '',
    f.departTime ?? '',
  ].join('|');
}

// ------------------------------------------------------------------ 카드 문구
/** 122000 → '122,000원'. 값이 없으면 '가격 문의'. */
export function priceText(f: Flight): string {
  if (!f.priceFrom) return '가격 문의';
  return `${f.priceFrom.toLocaleString('ko-KR')}원`;
}


export interface FlightProvider {
  readonly name: string;
  /**
   * 지금 검색을 할 수 있는 상태인가 (API 키 등). 안 주면 할 수 있는 것으로 본다.
   *
   * ⚠️ 이게 없으면 키가 빠진 서버가 **지키지 못할 약속**을 한다 —
   *    "30초쯤 뒤에 다시 물어봐 주세요" 라고 해놓고 영원히 결과가 없다.
   */
  readonly enabled?: boolean;
  /**
   * ⚠️ 느릴 수 있다(AI provider 는 7~30초). 호출부는 반드시 백그라운드에서만 부른다.
   * 카카오 5초 예산 안에서 도는 건 캐시 조회뿐이다.
   */
  search(query: FlightQuery): Promise<Flight[]>;
}

/**
 * provider DI 토큰.
 *
 * 구현을 직접 주입하지 않는 이유: 테스트에서 가짜 provider 로 갈아끼워야 하고
 * (실제 OpenAI 를 부르면 안 된다), FLIGHT_PROVIDER 설정으로도 바뀐다.
 */
export const FLIGHT_PROVIDER = 'FLIGHT_PROVIDER';


// ------------------------------------------------------- 플랫폼 줄 (FlightOffer)
/**
 * 편 목록을 **플랫폼별 한 줄로 접는다.**
 *
 * 모델이 준 편들은 대개 두세 플랫폼의 검색 페이지를 가리킨다. 그 페이지가 줄의
 * 신원이고, 편들에서 뽑은 시세·소요시간·항공사가 그 줄의 설명이 된다.
 *
 * ⚠️ **순서를 지킨다.** 모델이 앞에 둔 편의 플랫폼이 앞 줄이 된다 — 대개 가격이
 *    낮거나 유명한 쪽이다.
 */
export function toOffers(flights: Flight[], tripType: TripType): FlightOffer[] {
  const byMerchant = new Map<string, Flight[]>();
  for (const flight of flights) {
    if (!flight.sourceUrl) continue;
    const key = flight.merchant || flight.sourceUrl;
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), flight]);
  }

  const offers: FlightOffer[] = [];
  for (const [merchant, group] of byMerchant) {
    const prices = group.map((f) => f.priceFrom).filter((p): p is number => !!p && p > 0);
    const durations = group
      .map((f) => f.durationMinutes)
      .filter((d): d is number => !!d && d > 0);
    const first = group[0];

    offers.push({
      merchant,
      sourceUrl: first.sourceUrl,
      originCode: first.originCode,
      destCode: first.destCode,
      originName: first.originName ?? null,
      destName: first.destName ?? null,
      tripType,
      priceLow: prices.length ? Math.min(...prices) : null,
      priceHigh: prices.length ? Math.max(...prices) : null,
      durationMinutes: durations.length ? Math.min(...durations) : null,
      // 직항이 하나라도 있으면 그렇게 적는다. 아무 편도 stops 를 안 주면 모르는 것이다.
      nonstop: group.some((f) => f.stops === 0)
        ? true
        : group.some((f) => typeof f.stops === 'number')
          ? false
          : null,
      airlines: [...new Set(group.map((f) => f.airline).filter(Boolean))],
    });
  }
  return offers;
}

/** 캐시에서 살려낸 값이 플랫폼 줄 모양인가. 배포로 필드가 바뀌면 미스로 떨어뜨린다. */
export function isFlightOffer(item: unknown): item is FlightOffer {
  if (!item || typeof item !== 'object') return false;
  const o = item as FlightOffer;
  return typeof o.sourceUrl === 'string' && typeof o.merchant === 'string';
}

/** 같은 줄인지 판정하는 키. 플랫폼 하나당 한 줄이다. */
export function offerKey(offer: FlightOffer): string {
  return offer.merchant || offer.sourceUrl;
}

/**
 * 시세 표기. '12~18만원대' / '약 12만원대' / '' (모름).
 *
 * ⚠️ **만원 단위로 내림해서 범위로 적는다.** "122,000원" 처럼 정밀하게 쓰면 맞는
 *    것처럼 보이는데, 이 값은 웹 검색으로 얻은 예상가라 실제와 다를 수 있다.
 *    범위로 말하면 틀릴 일이 없고, 표기 자체가 "대략" 이라는 걸 알려준다.
 */
export function priceRangeText(offer: FlightOffer): string {
  const low = manwon(offer.priceLow);
  const high = manwon(offer.priceHigh);
  if (low === null) return '';
  if (high === null || high === low) return `약 ${low}만원대`;
  return `${low}~${high}만원대`;
}

function manwon(value: number | null | undefined): number | null {
  if (!value || value <= 0) return null;
  return Math.floor(value / 10_000);
}

/** '직항 1시간 55분' / '경유 · 5시간 20분' / ''. 둘 다 모르면 빈 문자열. */
export function routeText(offer: FlightOffer): string {
  const bits: string[] = [];
  if (offer.nonstop === true) bits.push('직항');
  else if (offer.nonstop === false) bits.push('경유');
  if (offer.durationMinutes) bits.push(durationText(offer.durationMinutes));
  return bits.join(' ');
}

/** '대한항공 · 아시아나 외 2곳'. 카드 한 줄에 다 못 넣으므로 둘까지만 적는다. */
export function airlinesText(offer: FlightOffer, limit = 2): string {
  const names = offer.airlines ?? [];
  if (!names.length) return '';
  const shown = names.slice(0, limit).join(' · ');
  const rest = names.length - limit;
  return rest > 0 ? `${shown} 외 ${rest}곳` : shown;
}

/** 카드 제목. 어디로 보내는 줄인지가 제목이다. */
export function offerTitle(offer: FlightOffer): string {
  return `${merchantLabel(offer.merchant)}에서 보기`;
}

/**
 * listCard 한 줄 설명(40자). **시세 → 직항·소요시간 → 항공사** 순.
 *
 * 시세를 줄마다 적는 게 중복이 아닌 이유 — **플랫폼마다 값이 다르다.** 어디가 싼지가
 * 사용자가 줄을 고르는 기준이라, 머리글로 올려 하나로 합치면 그 차이가 지워진다.
 */
export function offerDescription(offer: FlightOffer): string {
  return [priceRangeText(offer), routeText(offer), airlinesText(offer, 1)]
    .filter(Boolean)
    .join(' · ');
}

/** DB·로그에 남는 이름. 나중에 무엇이 노출됐는지 알아볼 수 있어야 한다. */
export function offerLabel(offer: FlightOffer): string {
  return `${merchantLabel(offer.merchant)} ${offer.originCode}→${offer.destCode}`;
}

/** 사람이 읽는 플랫폼 이름. 모르는 값은 그대로 쓴다. */
const MERCHANT_LABELS: Record<string, string> = {
  trip: '트립닷컴',
  myrealtrip: '마이리얼트립',
  interpark: '인터파크투어',
  skyscanner: '스카이스캐너',
};

export function merchantLabel(merchant: string): string {
  return MERCHANT_LABELS[merchant.toLowerCase()] ?? merchant;
}

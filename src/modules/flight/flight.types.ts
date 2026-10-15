/**
 * 편도/왕복.
 *
 * 라우터의 `rt`/`ow` 와 표기가 다르다. 여기 이름은 링크 조립과 카드 문구가 쓰는
 * 값이라, 변환은 한 줄이면 끝난다 ([flight.service.ts](./flight.service.ts) queryOf).
 */
export type TripType = 'oneway' | 'round';

/**
 * 카드 한 줄이 되는 값. **편이 아니라 "플랫폼 하나"다.**
 *
 * 편별로 줄을 내던 때는 줄마다 다른 편명·시각·가격을 찍으면서 **링크는 전부 같은
 * 곳으로 갔다** — 여러 편이 같은 노선 검색 페이지를 가리키기 때문이다. "피치
 * 89,000원" 을 누른 사람이 검색 결과를 봤고, 그 가격조차 웹 검색으로 얻은 예상가라
 * 실제와 달랐다.
 *
 * 지금은 **검색을 아예 하지 않는다**([link-offers.ts](./link-offers.ts)). 그래서
 * 시세·소요시간·항공사 칸이 없다 — 조사해야 아는 값이라 비워두느니 두지 않는다.
 * 줄이 보내는 곳과 노선만 있으면 카드는 만들어진다.
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

/** 카드 제목. 어디로 보내는 줄인지가 제목이다. */
export function offerTitle(offer: FlightOffer): string {
  return `${merchantLabel(offer.merchant)}에서 보기`;
}

/**
 * listCard 한 줄 설명(40자).
 *
 * ⚠️ **비워두면 세 줄이 똑같아 보인다** — 제목이 전부 "…에서 보기" 라 고를 단서가
 *    없다. 가격을 조사하지 않으므로 **플랫폼이 서로 어떻게 다른지**를 적는다.
 */
export function offerDescription(offer: FlightOffer): string {
  return merchantTagline(offer.merchant);
}

/**
 * 플랫폼이 서로 어떻게 다른가. **가격이 없을 때 줄을 고르는 단서다.**
 *
 * ⚠️ 셋의 성격이 실제로 다르다 — 스카이스캐너는 여러 예약처를 모아 보여주는
 *    메타서치고(그래서 애드픽 광고주가 없다), 나머지 둘은 자기가 파는 곳이다.
 *    모르는 플랫폼은 빈 줄로 둔다. 지어내면 그게 곧 거짓말이다.
 */
export function merchantTagline(merchant: string): string {
  return MERCHANT_TAGLINES[merchant.toLowerCase()] ?? '';
}

const MERCHANT_TAGLINES: Record<string, string> = {
  skyscanner: '여러 예약처 가격을 한 번에 비교',
  trip: '그 자리에서 예약·결제까지',
  myrealtrip: '한국어 고객센터 · 원화 결제',
};

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

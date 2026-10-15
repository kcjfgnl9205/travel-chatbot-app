import {
  FlightOffer,
  isFlightOffer,
  merchantLabel,
  merchantTagline,
  offerDescription,
  offerKey,
  offerLabel,
  offerTitle,
} from '../src/modules/flight/flight.types';

/**
 * 항공권 카드.
 *
 * **줄 하나가 편이 아니라 플랫폼 하나다.** 편별로 줄을 내던 때는 줄마다 다른
 * 편명·시각·가격을 찍으면서 **링크는 전부 같은 검색 페이지로 갔다** — "피치
 * 89,000원" 을 누른 사람이 검색 결과를 봤고, 그 가격조차 웹 검색으로 얻은
 * 예상가라 실제와 달랐다.
 *
 * 지금은 **검색 자체를 안 한다.** 그래서 시세·소요시간·항공사 칸이 아예 없고,
 * 줄 설명은 플랫폼이 서로 어떻게 다른지로 채운다.
 */

function offer(over: Partial<FlightOffer> = {}): FlightOffer {
  return {
    merchant: 'trip',
    sourceUrl: 'https://kr.trip.com/flights/showfarefirst?dcity=sel&acity=osa',
    originCode: 'ICN',
    destCode: 'KIX',
    tripType: 'round',
    ...over,
  };
}

describe('줄 문구', () => {
  it('제목은 어디로 보내는 줄인지다', () => {
    expect(offerTitle(offer())).toBe('트립닷컴에서 보기');
    expect(offerTitle(offer({ merchant: 'skyscanner' }))).toBe('스카이스캐너에서 보기');
  });

  /**
   * ⚠️ **비워두면 세 줄이 똑같아 보인다** — 제목이 전부 "…에서 보기" 라 고를 단서가
   *    사라진다. 가격을 조사하지 않으니 플랫폼의 성격을 적는다.
   */
  it('설명은 플랫폼이 서로 어떻게 다른지다', () => {
    expect(offerDescription(offer({ merchant: 'skyscanner' }))).toBe(
      '여러 예약처 가격을 한 번에 비교',
    );
    expect(offerDescription(offer({ merchant: 'trip' }))).toBe('그 자리에서 예약·결제까지');
  });

  // 모르는 플랫폼은 빈 줄이다. 지어내면 그게 곧 거짓말이다.
  it('모르는 플랫폼은 설명을 지어내지 않는다', () => {
    expect(merchantTagline('처음보는곳')).toBe('');
    expect(merchantLabel('처음보는곳')).toBe('처음보는곳');
  });

  /** DB·로그에 남는 이름. 나중에 무엇이 노출됐는지 알아볼 수 있어야 한다. */
  it('기록용 이름에는 플랫폼과 구간이 들어간다', () => {
    expect(offerLabel(offer())).toBe('트립닷컴 ICN→KIX');
  });
});

describe('신원', () => {
  it('플랫폼 하나당 한 줄이다', () => {
    expect(offerKey(offer())).toBe(offerKey(offer({ sourceUrl: 'https://kr.trip.com/other' })));
    expect(offerKey(offer())).not.toBe(offerKey(offer({ merchant: 'myrealtrip' })));
  });

  /**
   * ⚠️ 캐시에 저장된 행은 **예전 배포의 모양**일 수 있다. 시세를 담던 시절의 줄이
   *    섞여 들어와도 카드가 깨지면 안 된다 — 보내는 곳만 멀쩡하면 줄은 만들어진다.
   */
  it('플랫폼과 주소만 있으면 살려 쓴다', () => {
    expect(isFlightOffer(offer())).toBe(true);
    expect(isFlightOffer({ merchant: 'trip', sourceUrl: 'https://x', priceLow: 120_000 })).toBe(
      true,
    );
    expect(isFlightOffer({ merchant: 'trip' })).toBe(false);
    expect(isFlightOffer(null)).toBe(false);
  });
});

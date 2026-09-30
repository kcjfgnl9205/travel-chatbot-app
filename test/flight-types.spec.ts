import {
  Flight,
  FlightOffer,
  airlinesText,
  flightKey,
  isFlightOffer,
  offerDescription,
  offerKey,
  offerLabel,
  offerTitle,
  priceRangeText,
  routeText,
  toOffers,
} from '../src/modules/flight/flight.types';

/**
 * 항공권 카드.
 *
 * **줄 하나가 편이 아니라 플랫폼 하나다.** 편별로 줄을 내던 때는 줄마다 다른
 * 편명·시각·가격을 찍으면서 **링크는 전부 같은 검색 페이지로 갔다** — "피치
 * 89,000원" 을 누른 사람이 검색 결과를 봤고, 그 가격조차 웹 검색으로 얻은
 * 예상가라 실제와 달랐다.
 */

function flight(over: Partial<Flight> = {}): Flight {
  return {
    airline: '대한항공',
    flightNo: 'KE723',
    originCode: 'ICN',
    destCode: 'KIX',
    tripType: 'round',
    sourceUrl: 'https://kr.trip.com/flights/icn-kix',
    merchant: 'trip',
    priceFrom: 122_000,
    durationMinutes: 115,
    stops: 0,
    ...over,
  };
}

function offer(over: Partial<FlightOffer> = {}): FlightOffer {
  return {
    merchant: 'trip',
    sourceUrl: 'https://kr.trip.com/flights/icn-kix',
    originCode: 'ICN',
    destCode: 'KIX',
    tripType: 'round',
    priceLow: 122_000,
    priceHigh: 186_000,
    durationMinutes: 115,
    nonstop: true,
    airlines: ['대한항공', '아시아나항공'],
    ...over,
  };
}

describe('편을 플랫폼 줄로 접기', () => {
  it('플랫폼마다 한 줄이 된다', () => {
    const offers = toOffers(
      [
        flight({ merchant: 'trip' }),
        flight({ merchant: 'trip', airline: '아시아나항공', priceFrom: 186_000 }),
        flight({ merchant: 'myrealtrip', sourceUrl: 'https://myrealtrip.com/f' }),
      ],
      'round',
    );

    expect(offers.map((o) => o.merchant)).toEqual(['trip', 'myrealtrip']);
  });

  it('시세는 그 플랫폼 편들의 폭이다', () => {
    const [o] = toOffers(
      [
        flight({ priceFrom: 122_000 }),
        flight({ priceFrom: 186_000, airline: '피치' }),
        flight({ priceFrom: 150_000, airline: '제주항공' }),
      ],
      'round',
    );

    expect(o.priceLow).toBe(122_000);
    expect(o.priceHigh).toBe(186_000);
  });

  it('가장 짧은 비행 시간을 쓴다', () => {
    const [o] = toOffers(
      [flight({ durationMinutes: 320, stops: 1 }), flight({ durationMinutes: 115 })],
      'round',
    );

    expect(o.durationMinutes).toBe(115);
  });

  /** 직항이 하나라도 있으면 그렇게 적는다. 아무도 stops 를 안 주면 모르는 것이다. */
  it('직항 여부를 판정한다', () => {
    expect(toOffers([flight({ stops: 1 }), flight({ stops: 0 })], 'round')[0].nonstop).toBe(true);
    expect(toOffers([flight({ stops: 1 })], 'round')[0].nonstop).toBe(false);
    expect(toOffers([flight({ stops: null })], 'round')[0].nonstop).toBeNull();
  });

  it('항공사를 중복 없이 모은다', () => {
    const [o] = toOffers(
      [flight(), flight(), flight({ airline: '피치' })],
      'round',
    );

    expect(o.airlines).toEqual(['대한항공', '피치']);
  });

  /** 주소가 없으면 보낼 곳이 없다 — 줄을 만들 수 없다. */
  it('주소 없는 편은 버린다', () => {
    expect(toOffers([flight({ sourceUrl: '' })], 'round')).toEqual([]);
  });
});

describe('시세 표기 — 범위로 말한다', () => {
  /**
   * ⚠️ "122,000원" 은 맞는 것처럼 보이지만 웹 검색으로 얻은 예상가라 틀릴 수 있다.
   *    "12~18만원대" 는 틀릴 일이 없고, 표기 자체가 "대략" 이라고 알려준다.
   */
  it('만원 단위 범위로 적는다', () => {
    expect(priceRangeText(offer())).toBe('12~18만원대');
  });

  it('폭이 없으면 한 값으로', () => {
    expect(priceRangeText(offer({ priceLow: 122_000, priceHigh: 122_000 }))).toBe('약 12만원대');
    expect(priceRangeText(offer({ priceHigh: null }))).toBe('약 12만원대');
  });

  it('모르면 빈 문자열 — 그 조각을 통째로 뺀다', () => {
    expect(priceRangeText(offer({ priceLow: null, priceHigh: null }))).toBe('');
  });
});

describe('줄 문구', () => {
  it('제목은 어디로 보내는지다', () => {
    expect(offerTitle(offer())).toBe('트립닷컴에서 보기');
    expect(offerTitle(offer({ merchant: 'myrealtrip' }))).toBe('마이리얼트립에서 보기');
  });

  it('모르는 플랫폼은 이름을 그대로 쓴다', () => {
    expect(offerTitle(offer({ merchant: 'agoda' }))).toBe('agoda에서 보기');
  });

  /** 시세를 맨 앞에 둔다 — 어디가 싼지가 줄을 고르는 기준이다. */
  it('설명은 시세 · 직항·소요시간 · 항공사', () => {
    expect(offerDescription(offer())).toBe('12~18만원대 · 직항 1시간 55분 · 대한항공 외 1곳');
  });

  it('항공사가 많으면 둘만 적고 나머지는 센다', () => {
    const text = airlinesText(offer({ airlines: ['대한항공', '아시아나항공', '피치', '제주항공'] }));
    expect(text).toBe('대한항공 · 아시아나항공 외 2곳');
  });

  it('없는 조각은 건너뛴다', () => {
    expect(routeText(offer({ nonstop: null, durationMinutes: null }))).toBe('');
    expect(
      offerDescription(
        offer({ nonstop: null, durationMinutes: null, airlines: [], priceLow: null, priceHigh: null }),
      ),
    ).toBe('');
  });

  /** DB·로그에 남는 이름. 나중에 무엇이 노출됐는지 알아볼 수 있어야 한다. */
  it('기록용 이름에는 플랫폼과 구간이 들어간다', () => {
    expect(offerLabel(offer())).toBe('트립닷컴 ICN→KIX');
  });
});

describe('신원', () => {
  it('플랫폼 하나당 한 줄이다', () => {
    expect(offerKey(offer())).toBe(offerKey(offer({ priceLow: 999 })));
    expect(offerKey(offer())).not.toBe(offerKey(offer({ merchant: 'myrealtrip' })));
  });

  /** 편 단위 중복은 접기 전에 걸러야 시세 폭이 안 왜곡된다. */
  it('편은 편명+시각으로 판정한다', () => {
    expect(flightKey(flight())).toBe(flightKey(flight({ priceFrom: 999 })));
    expect(flightKey(flight())).not.toBe(flightKey(flight({ flightNo: 'OZ112' })));
  });
});

describe('저장된 값을 살려낼 때', () => {
  it('모양이 맞으면 통과', () => {
    expect(isFlightOffer(offer())).toBe(true);
  });

  it('배포로 필드가 바뀌어 모양이 깨지면 버린다', () => {
    expect(isFlightOffer({ merchant: 'trip' })).toBe(false);
    expect(isFlightOffer(null)).toBe(false);
  });
});

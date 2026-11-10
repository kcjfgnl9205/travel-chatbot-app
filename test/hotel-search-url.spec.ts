import { parseTripParams } from '../src/modules/flight/trip-params';
import {
  hotelSearchUrl,
  hotelSearchUrls,
  resolveStay,
  stayProblem,
  stayReachesUser,
  staySupported,
  withStay,
  withoutStay,
} from '../src/modules/hotel/search-url';

/**
 * 호텔 **검색 결과** 주소.
 *
 * ⚠️ **여기 적힌 형식은 지어낸 것이 아니다.** 네 플랫폼에서 실제로 검색해 주소창을
 *    복사한 것을 받아, 우리가 만들 수 없는 값(추적 GUID·내부 지역 번호)을 덜어낸 뒤
 *    브라우저에서 다시 열어 확인했다 (2026-11-02). 항공권이 같은 규칙을 쓴다.
 *
 * ⚠️ 클룩·트립닷컴은 **일부러 없다.** 둘 다 지역을 내부 숫자 ID 로 받아서
 *    (`city_id=29`, `city=219`) 한국어 지명만 들고 있는 우리는 만들 수 없다.
 */

/** 2026-11-02(월) 12:00 KST. 서버가 UTC 로 돌아도 서울의 '오늘' 이어야 한다. */
const NOW = new Date('2026-11-02T03:00:00Z');

const paramsOf = (url: string) => new URL(url).searchParams;

describe('호텔 검색 주소', () => {
  it('호텔스닷컴은 지역을 이름 그대로 받는다 — 내부 ID 가 필요 없다', () => {
    const url = hotelSearchUrl(
      'hotels',
      {
        placeName: '오사카',
        stay: { checkIn: '2026-11-20', checkOut: '2026-11-23', nights: null, adults: 2 },
      },
      NOW,
    )!;

    expect(new URL(url).host).toBe('kr.hotels.com');
    const p = paramsOf(url);
    expect(p.get('destination')).toBe('오사카');
    expect(p.get('startDate')).toBe('2026-11-20');
    expect(p.get('endDate')).toBe('2026-11-23');
    // 사이트가 같은 값을 d1/d2 로도 붙인다. 한 칸이라도 빼면 조용히 기본값이 될 수 있다.
    expect(p.get('d1')).toBe('2026-11-20');
    expect(p.get('d2')).toBe('2026-11-23');
    expect(p.get('adults')).toBe('2');
    expect(p.get('rooms')).toBe('1');
  });

  /**
   * ⚠️ **우리가 만들 수 없는 값은 안 보낸다.** 주소창에는 타이프어헤드 세션 GUID
   *    (`typeaheadCollationId`)가 붙어 있었다. 빼고도 검색이 되는 것을 확인했다.
   */
  it('만들 수 없는 추적 파라미터는 보내지 않는다', () => {
    const url = hotelSearchUrl('hotels', { placeName: '오사카' }, NOW)!;

    expect(url).not.toContain('typeaheadCollationId');
  });

  /** **3번이 여기서 풀린다.** 이름으로 받으므로 동네도 그대로 들어간다. */
  it('세부 지역도 이름 그대로 넣는다 — "해운대"·"신주쿠"', () => {
    expect(paramsOf(hotelSearchUrl('hotels', { placeName: '해운대' }, NOW)!).get('destination')).toBe(
      '해운대',
    );
    expect(
      paramsOf(hotelSearchUrl('myrealtrip', { placeName: '신주쿠' }, NOW)!).get('keyword'),
    ).toBe('신주쿠');
  });

  it('마이리얼트립은 keyword 단독으로 검색한다 — regionId 는 내부 번호다', () => {
    const url = hotelSearchUrl(
      'myrealtrip',
      {
        placeName: '오사카',
        stay: { checkIn: '2026-11-20', checkOut: '2026-11-23', nights: null, adults: 3 },
      },
      NOW,
    )!;

    expect(url).not.toContain('regionId');
    const p = paramsOf(url);
    expect(p.get('keyword')).toBe('오사카');
    expect(p.get('checkIn')).toBe('2026-11-20');
    expect(p.get('adultCount')).toBe('3');
    expect(p.get('roomCount')).toBe('1');
  });

  it('국내·해외 탭을 가른다', () => {
    expect(paramsOf(hotelSearchUrl('myrealtrip', { placeName: '부산' }, NOW)!).get('isDomestic')).toBe(
      'true',
    );
    expect(
      paramsOf(hotelSearchUrl('myrealtrip', { placeName: '오사카' }, NOW)!).get('isDomestic'),
    ).toBe('false');
  });

  it('형식을 모르는 제휴몰은 null 이다 — 지어내지 않는다', () => {
    // 클룩·트립닷컴은 내부 도시 ID 가 있어야 한다. 빈 폼을 여느니 줄을 안 만든다.
    expect(hotelSearchUrl('klook', { placeName: '오사카' }, NOW)).toBeNull();
    expect(hotelSearchUrl('trip', { placeName: '오사카' }, NOW)).toBeNull();
  });

  it('지역이 없으면 주소를 만들지 않는다', () => {
    expect(hotelSearchUrl('hotels', { placeName: '  ' }, NOW)).toBeNull();
  });

  it('만들 수 있는 제휴몰만 줄로 낸다 — 마이리얼트립은 링크가 차단돼 뺐다', () => {
    expect(hotelSearchUrls({ placeName: '오사카' }, NOW).map((l) => l.merchant)).toEqual([
      'hotels',
    ]);
  });
});

describe('숙박 조건 기본값', () => {
  it('아무것도 못 읽으면 내일 체크인·1박·2명', () => {
    expect(resolveStay(null, NOW)).toEqual({
      checkIn: '2026-11-03',
      checkOut: '2026-11-04',
      adults: 2,
      rooms: 1,
      adultsClamped: false,
    });
  });

  it('체크아웃을 안 말했으면 박수만큼 민다 — 오늘이 아니라 체크인에서 센다', () => {
    expect(
      resolveStay({ checkIn: '2026-12-10', checkOut: null, nights: 3, adults: null }, NOW),
    ).toMatchObject({ checkIn: '2026-12-10', checkOut: '2026-12-13' });
  });

  /** ⚠️ 호텔은 **1박 이상**이어야 검색이 된다. 항공권의 당일치기와 다르다. */
  it('체크아웃이 체크인보다 앞서거나 같으면 기본값으로 돌린다', () => {
    expect(
      resolveStay({ checkIn: '2026-12-10', checkOut: '2026-12-08', nights: null, adults: null }, NOW),
    ).toMatchObject({ checkOut: '2026-12-11' });
    expect(
      resolveStay({ checkIn: '2026-12-10', checkOut: '2026-12-10', nights: null, adults: null }, NOW),
    ).toMatchObject({ checkOut: '2026-12-11' });
  });

  /**
   * ⚠️ **6명을 넘으면 줄이되, 줄였다고 말할 수 있어야 한다.** 그 위는 제휴몰이 객실을
   *    나누라고 요구하는데 우리는 방을 몇 개로 쪼갤지 모른다. 말없이 6명으로 보내면
   *    8명이라고 말한 사람이 8명으로 검색된 줄 안다.
   */
  it('인원은 6명까지만 넣고, 줄였으면 표시한다', () => {
    const many = resolveStay({ checkIn: null, checkOut: null, nights: null, adults: 8 }, NOW);
    expect(many.adults).toBe(6);
    expect(many.adultsClamped).toBe(true);

    const six = resolveStay({ checkIn: null, checkOut: null, nights: null, adults: 6 }, NOW);
    expect(six.adults).toBe(6);
    expect(six.adultsClamped).toBe(false);

    // 못 읽었거나 말이 안 되는 값은 기본값 2명이다. **줄인 게 아니다.**
    const none = resolveStay({ checkIn: null, checkOut: null, nights: null, adults: 0 }, NOW);
    expect(none.adults).toBe(2);
    expect(none.adultsClamped).toBe(false);
  });
});

/**
 * 되물어야 하는 날짜.
 *
 * ⚠️ **항공권과 하나가 다르다** — 체크인과 체크아웃이 같은 날이면 0박이라 검색이
 *    안 된다. 항공권에서 같은 날은 당일치기라 멀쩡한 일정이다.
 */
describe('숙박 날짜 되묻기 판정', () => {
  const parse = (utterance: string) => parseTripParams(utterance, NOW);

  it('체크인과 체크아웃이 같은 날이면 되묻는다 — 호텔은 0박을 못 찾는다', () => {
    expect(stayProblem(parse('오사카 호텔 11월 20일 체크인 11월 20일 체크아웃'))).toEqual({
      kind: 'same-day',
      date: '2026-11-20',
    });
  });

  it('1박이면 되묻지 않는다', () => {
    expect(stayProblem(parse('오사카 호텔 11월 20일 체크인 11월 21일 체크아웃'))).toBeNull();
  });

  /** 상대 표현을 파서가 한 날로 읽은 것까지 되물으면, 말한 적 없는 날짜를 질문받는다. */
  it('직접 말한 날짜가 아니면 되묻지 않는다', () => {
    expect(stayProblem(parse('오사카 호텔 주말에'))).toBeNull();
  });

  it('지난 날짜·거꾸로 선 일정은 항공권과 같은 판정을 쓴다', () => {
    expect(stayProblem(parse('오사카 호텔 2025년 11월 20일'))).toMatchObject({ kind: 'past' });
    expect(
      stayProblem(parse('오사카 호텔 11월 23일 체크인 11월 20일 체크아웃')),
    ).toMatchObject({ kind: 'reversed' });
  });

  it('날짜를 안 말했으면 문제가 없다', () => {
    expect(stayProblem(parse('오사카 호텔 추천해줘'))).toBeNull();
    expect(stayProblem(null)).toBeNull();
  });
});

/**
 * 호텔 **상세 페이지**에 조건 박기.
 *
 * ⚠️ **여기 적힌 형식도 지어낸 것이 아니다.** 네 곳에서 실제로 호텔 하나를 날짜·인원
 *    넣고 연 뒤 주소창을 복사한 것이고(2026-11-09), 우리가 만들 수 없는 값(추적 토큰·
 *    내부 번호)을 덜어냈다. 검색 결과 주소와 같은 규칙이다.
 *
 * ⚠️ **확인한 경로 모양에만 붙인다.** 같은 사이트에도 상세 주소가 여러 꼴이라
 *    (`/hotels/detail/` vs `/hotels/오사카-hotel-detail-688242/`) 호스트만 보고 붙이면
 *    무시되는 꼴이 생기고, 그러면 카드에 적은 날짜와 열리는 날짜가 갈린다.
 */
describe('호텔 상세 주소', () => {
  const stay = { checkIn: '2026-11-20', checkOut: '2026-11-23', nights: null, adults: 3 };

  it('호텔스닷컴 — chkin·chkout 과 객실별 인원(rm1=a3)', () => {
    const url = withStay(
      'https://kr.hotels.com/ho1948759872/hotel-intergate-osaka-umeda-osaka-ilbon/',
      stay,
      NOW,
    );

    const p = paramsOf(url);
    expect(p.get('chkin')).toBe('2026-11-20');
    expect(p.get('chkout')).toBe('2026-11-23');
    // `adults=3` 이 아니다. 상세는 방 번호를 앞에 단 `rm1=a3` 꼴로 받는다.
    expect(p.get('rm1')).toBe('a3');
  });

  it('트립닷컴 — 아이 수·객실 수까지 같이 보낸다', () => {
    const url = withStay(
      'https://kr.trip.com/hotels/detail/?cityId=248&hotelId=49507812&locale=ko-KR',
      stay,
      NOW,
    );

    const p = paramsOf(url);
    expect(p.get('checkIn')).toBe('2026-11-20');
    expect(p.get('checkOut')).toBe('2026-11-23');
    expect(p.get('adult')).toBe('3');
    expect(p.get('children')).toBe('0');
    expect(p.get('crn')).toBe('1');
    // 호텔의 신원은 건드리지 않는다.
    expect(p.get('hotelId')).toBe('49507812');
  });

  it('클룩 — 로케일이 경로에 있어도 찾는다', () => {
    const url = withStay(
      'https://www.klook.com/ko/hotels/detail/1134329-prince-smart-inn-osaka-yodoyabashi/',
      stay,
      NOW,
    );

    const p = paramsOf(url);
    expect(p.get('check_in')).toBe('2026-11-20');
    expect(p.get('check_out')).toBe('2026-11-23');
    expect(p.get('adult_num')).toBe('3');
    expect(p.get('room_num')).toBe('1');
  });

  it('마이리얼트립 — 숙소 상세는 검색과 같은 이름의 칸을 쓴다', () => {
    const url = withStay(
      'https://accommodation.myrealtrip.com/union/products/5007313',
      stay,
      NOW,
    );

    const p = paramsOf(url);
    expect(p.get('checkIn')).toBe('2026-11-20');
    expect(p.get('checkOut')).toBe('2026-11-23');
    expect(p.get('adultCount')).toBe('3');
    expect(p.get('childCount')).toBe('0');
    // ⚠️ 국내/해외 탭은 상품 번호가 이미 정한다. 잘못 넣으면 탭만 틀어진다.
    expect(p.has('isDomestic')).toBe(false);
  });

  it('조건을 안 말했으면 기본값이 박힌다 — 내일 체크인 · 1박 · 2명', () => {
    const p = paramsOf(
      withStay('https://accommodation.myrealtrip.com/union/products/5007313', null, NOW),
    );

    expect(p.get('checkIn')).toBe('2026-11-03');
    expect(p.get('checkOut')).toBe('2026-11-04');
    expect(p.get('adultCount')).toBe('2');
  });

  it('인원은 6명을 넘지 않는다 — 방이 하나라서다', () => {
    const many = { checkIn: null, checkOut: null, nights: null, adults: 9 };

    expect(
      paramsOf(withStay('https://kr.hotels.com/ho1948759872/x/', many, NOW)).get('rm1'),
    ).toBe('a6');
  });

  /**
   * ⚠️ **확인하지 않은 꼴에는 안 붙인다.** 모델은 같은 사이트의 다른 주소 꼴도 주는데,
   *    거기서 파라미터가 무시되면 카드에 적은 날짜와 열리는 날짜가 갈린다. 그때는
   *    조건을 말하지 않는 쪽(`staySupported === false`)이 맞다.
   */
  it('확인하지 않은 주소 꼴은 건드리지 않는다', () => {
    const unknown = [
      // 트립닷컴의 다른 상세 꼴.
      'https://kr.trip.com/hotels/osaka-hotel-detail-688242/',
      // 마이리얼트립 오퍼 페이지.
      'https://www.myrealtrip.com/offers/12345',
      // 클룩의 옛 상세 꼴.
      'https://www.klook.com/ko/hotel/12345-abc/',
      // 호텔 상세가 아니라 목록.
      'https://kr.trip.com/hotels/osaka-list',
    ];

    for (const url of unknown) {
      expect(withStay(url, stay, NOW)).toBe(url);
      expect(staySupported(url)).toBe(false);
    }
  });

  it('주소가 아니면 그대로 돌려준다', () => {
    expect(withStay('그냥 글자', stay, NOW)).toBe('그냥 글자');
    expect(staySupported('')).toBe(false);
  });
});

/**
 * **붙는 것과 닿는 것은 다르다.**
 *
 * 호텔스닷컴은 주소에 `chkin`·`chkout`·`rm1` 이 멀쩡히 붙고 브라우저로 직접 열면
 * 반영되는데, **애드픽 → Partnerize 경유에서 쿼리가 통째로 날아간다**
 * ([ISSUE 문서](../docs/ISSUE-2026-11-09-HOTELS-COM-STAY.md), 2026-11-09). 그런데도
 * 「링크는 12월 2일 체크인 … 으로 열려요」를 적어놨더니 사용자는 그 안내를 믿고
 * 날짜가 빈 페이지에서 예약하러 갔다 — 아무 말 안 하는 것보다 나쁘다.
 *
 * ⚠️ **지금은 호텔 검색이 트립닷컴만 쓰므로 이 갈래가 운영에서는 안 걸린다.** 그래도
 *    판정은 남겨둔다 — 다른 사이트를 다시 켤 때 이 구분이 없으면 같은 거짓말이 그대로
 *    돌아온다. 라우터 통합 테스트로는 더 이상 재현할 수 없어서 여기서 지킨다.
 */
describe('조건이 사용자에게 닿는가', () => {
  const trip = 'https://kr.trip.com/hotels/detail/?hotelId=1';
  const hotels = 'https://kr.hotels.com/ho1180944672/hotel-granvia/';
  const stay = { checkIn: '2026-11-20', checkOut: '2026-11-23', nights: null, adults: 3 };

  it('트립닷컴은 닿는다 — 애드픽을 거쳐도 유지되는 것을 확인했다 (2026-11-10)', () => {
    expect(staySupported(trip)).toBe(true);
    expect(stayReachesUser(trip)).toBe(true);
  });

  it('호텔스닷컴은 붙지만 닿지 않는다', () => {
    // 주소에는 붙는다 — 애드픽 변환이 실패하면 원본으로 가고, 그때는 살아서 간다.
    expect(staySupported(hotels)).toBe(true);
    expect(new URL(withStay(hotels, stay, NOW)).searchParams.get('chkin')).toBe('2026-11-20');
    // 하지만 카드는 날짜를 말하면 안 된다.
    expect(stayReachesUser(hotels)).toBe(false);
  });

  it('조건을 못 붙이는 주소는 당연히 닿지도 않는다', () => {
    expect(stayReachesUser('https://kr.trip.com/hotels/osaka-hotel-detail-688242/')).toBe(false);
    expect(stayReachesUser('그냥 글자')).toBe(false);
  });
});

/**
 * 조건을 **도로 떼는** 길. 애드픽 추적 코드(`p_data` = `sha1(주소)`)가 이걸 본다.
 *
 * ⚠️ **같은 호텔은 날짜가 달라도 같은 코드여야 한다.** 조건이 박힌 주소로 코드를
 *    만들면 성과 화면에서 한 호텔이 수십 줄로 쪼개지고, 전환은 드물어서 한 줄에
 *    0 아니면 1 이 찍힌다 — 아무것도 못 읽는다.
 */
describe('조건을 뗀 주소', () => {
  const base = 'https://accommodation.myrealtrip.com/union/products/5007313';
  const stay = { checkIn: '2026-11-20', checkOut: '2026-11-23', nights: null, adults: 3 };

  it('날짜·인원이 달라도 같은 주소로 돌아온다 — 추적 코드가 안 갈린다', () => {
    const a = withStay(base, { checkIn: '2026-11-20', checkOut: '2026-11-23', nights: null, adults: 3 }, NOW);
    const b = withStay(base, { checkIn: '2026-12-01', checkOut: '2026-12-05', nights: null, adults: 2 }, NOW);

    expect(a).not.toBe(b); // 링크는 달라야 한다 — 각자 자기 날짜로 열린다
    expect(withoutStay(a)).toBe(withoutStay(b));
    expect(withoutStay(a)).toBe(base);
  });

  it('네 곳 모두 뗀 뒤가 원래 주소다', () => {
    const urls = [
      'https://kr.hotels.com/ho1948759872/hotel-intergate-osaka-umeda/',
      'https://kr.trip.com/hotels/detail/?cityId=248&hotelId=49507812',
      'https://www.klook.com/ko/hotels/detail/1134329-prince-smart-inn/',
      base,
    ];

    for (const url of urls) {
      expect(withoutStay(withStay(url, stay, NOW))).toBe(url);
    }
  });

  /**
   * ⚠️ **같은 이름의 칸이라도 남의 주소는 건드리지 않는다.** `adult` 는 마이리얼트립
   *    **항공권** 검색 주소에도 있는 칸이다. 호스트만 보고 떼면 항공권 추적이 노선별이
   *    아니라 통째로 뭉개진다.
   */
  it('호텔 상세가 아닌 주소는 그대로 둔다 — 항공권 주소를 건드리면 안 된다', () => {
    const flight = 'https://air-web.myrealtrip.com/results?trip=SEL-OSA&adult=3&cabins=ECONOMY';

    expect(withoutStay(flight)).toBe(flight);
    expect(withoutStay('https://kr.trip.com/hotels/osaka-hotel-detail-688242/')).toBe(
      'https://kr.trip.com/hotels/osaka-hotel-detail-688242/',
    );
    expect(withoutStay('그냥 글자')).toBe('그냥 글자');
  });
});

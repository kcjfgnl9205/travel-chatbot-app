import {
  hotelSearchUrl,
  hotelSearchUrls,
  resolveStay,
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

  it('만들 수 있는 제휴몰만 줄로 낸다', () => {
    expect(hotelSearchUrls({ placeName: '오사카' }, NOW).map((l) => l.merchant)).toEqual([
      'hotels',
      'myrealtrip',
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

  it('인원은 플랫폼이 받는 범위로 자른다', () => {
    expect(resolveStay({ checkIn: null, checkOut: null, nights: null, adults: 20 }, NOW).adults).toBe(9);
    expect(resolveStay({ checkIn: null, checkOut: null, nights: null, adults: 0 }, NOW).adults).toBe(2);
  });
});

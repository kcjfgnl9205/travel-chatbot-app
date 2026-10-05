import { RETURN_AFTER_DAYS, datedSearchUrl, seoulDate } from '../src/modules/flight/search-url';

/**
 * 항공권 링크를 **검색된 상태**로 연다.
 *
 * 모델이 주는 건 빈 검색 폼(노선 페이지)이라, 카드에서 가격을 보고 누른 사람이
 * 날짜를 다시 입력해야 했다. 오늘~7일 뒤·1인으로 고정해서 결과를 바로 띄운다.
 *
 * ⚠️ **저장하면 안 되는 값이다.** 캐시는 날짜를 키에 넣지 않고 24시간 사니까
 *    (0004), 구워서 저장하면 내일 캐시를 맞은 사람이 어제 날짜를 받는다. 그래서
 *    `now` 를 인자로 받는다 — 테스트가 고정할 수 있다는 것이 곧 렌더 시점에
 *    만든다는 증거다.
 */

/** 2026-10-05 12:00 KST. */
const NOW = new Date('2026-10-05T03:00:00Z');

const SKY = { originCode: 'ICN', destCode: 'KIX', merchant: 'skyscanner' } as const;
const TRIP = { originCode: 'ICN', destCode: 'KIX', merchant: 'trip' } as const;

describe('항공권 검색 주소', () => {
  it('스카이스캐너는 날짜를 경로에 YYMMDD 로 넣는다', () => {
    const url = datedSearchUrl({ ...SKY, tripType: 'round' }, NOW)!;

    expect(url).toContain('/transport/flights/icn/kix/261005/261012/');
    expect(url).toContain('adults=1');
    expect(url).toContain('cabinclass=economy');
  });

  it('트립닷컴은 날짜를 쿼리로 넣는다', () => {
    const url = new URL(datedSearchUrl({ ...TRIP, tripType: 'round' }, NOW)!);

    expect(url.pathname).toBe('/flights/showfarefirst');
    expect(url.searchParams.get('dcity')).toBe('icn');
    expect(url.searchParams.get('acity')).toBe('kix');
    expect(url.searchParams.get('ddate')).toBe('2026-10-05');
    expect(url.searchParams.get('rdate')).toBe('2026-10-12');
    expect(url.searchParams.get('quantity')).toBe('1');
    expect(url.searchParams.get('triptype')).toBe('rt');
  });

  /** ⚠️ 빈 rdate 를 넣으면 왕복 폼이 열린다. 키 자체가 없어야 한다. */
  it('편도는 돌아오는 날을 아예 빼야 한다', () => {
    const trip = new URL(datedSearchUrl({ ...TRIP, tripType: 'oneway' }, NOW)!);
    expect(trip.searchParams.has('rdate')).toBe(false);
    expect(trip.searchParams.get('triptype')).toBe('ow');

    const sky = datedSearchUrl({ ...SKY, tripType: 'oneway' }, NOW)!;
    expect(sky).toContain('/icn/kix/261005/?');
    expect(sky).not.toContain('261012');
  });

  /**
   * ⚠️ **형식을 모르는 제휴몰은 건드리지 않는다.** 지어낸 주소로 바꾸는 것은
   *    빈 폼을 여는 것보다 나쁘다 — 404 로 떨어진다.
   */
  it('모르는 제휴몰이면 null — 호출부가 원본을 쓴다', () => {
    expect(datedSearchUrl({ ...TRIP, merchant: 'myrealtrip', tripType: 'round' }, NOW)).toBeNull();
    expect(datedSearchUrl({ ...TRIP, merchant: null, tripType: 'round' }, NOW)).toBeNull();
  });

  it('공항 코드가 없으면 null — 노선을 특정할 수 없다', () => {
    expect(datedSearchUrl({ ...SKY, originCode: '', tripType: 'round' }, NOW)).toBeNull();
    expect(datedSearchUrl({ ...SKY, destCode: '서울', tripType: 'round' }, NOW)).toBeNull();
  });

  /**
   * ⚠️ **서버가 UTC 라도 사용자의 "오늘" 이어야 한다.** 한국 시간 09:00 이전에
   *    `new Date()` 를 그대로 쓰면 전날이 나와, 새벽에 물어본 사람에게 어제 출발하는
   *    항공권을 검색해 준다.
   */
  it('날짜는 한국 시간 기준이다', () => {
    // 2026-10-05 08:00 KST = 2026-10-04 23:00 UTC. UTC 로 읽으면 10/04 가 된다.
    const dawn = new Date('2026-10-04T23:00:00Z');

    expect(seoulDate(dawn)).toBe('2026-10-05');
    expect(datedSearchUrl({ ...SKY, tripType: 'round' }, dawn)).toContain('/261005/');
  });

  it('돌아오는 날은 7일 뒤다', () => {
    expect(RETURN_AFTER_DAYS).toBe(7);
    expect(seoulDate(NOW, RETURN_AFTER_DAYS)).toBe('2026-10-12');
  });
});

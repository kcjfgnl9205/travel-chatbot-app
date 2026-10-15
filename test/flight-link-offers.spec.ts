import { FlightQuery } from '../src/modules/flight/flight.types';
import { LINK_MERCHANTS, linkOffers } from '../src/modules/flight/link-offers';
import { datedSearchUrl } from '../src/modules/flight/search-url';
import { parseTripParams } from '../src/modules/flight/trip-params';

/**
 * 검색 없이 만드는 항공권 카드.
 *
 * 줄 링크는 어차피 우리가 IATA 코드로 조립한다 — 모델이 주는 주소는 빈 검색 폼이라
 * 쓰지 않는다. 모델이 사오는 건 시세 한 줄뿐이고, 그걸 포기하면 **항공권은 검색할
 * 것이 없다.** 그 대가로 즉답·0원·빈손 없음을 얻는다.
 */

/** 2026-10-14(수) 12:00 KST. */
const NOW = new Date('2026-10-14T03:00:00Z');

function query(over: Partial<FlightQuery> = {}): FlightQuery {
  return {
    originSlug: 'seoul',
    originName: '서울',
    originCode: 'GMP',
    destSlug: 'jeju',
    destName: '제주',
    destCode: 'CJU',
    tripType: 'round',
    limit: 20,
    originAssumed: true,
    ...over,
  };
}

describe('링크 카드', () => {
  it('플랫폼마다 줄 하나씩 만든다', () => {
    const offers = linkOffers(query(), NOW);

    expect(offers.map((o) => o.merchant)).toEqual([...LINK_MERCHANTS]);
    expect(offers.every((o) => o.sourceUrl.startsWith('https://'))).toBe(true);
  });

  // ⚠️ 조사해야 아는 값이다. 지어내면 그게 곧 거짓말이고, 느린 것보다 나쁘다.
  it('노선과 보내는 곳 말고는 아무것도 담지 않는다', () => {
    for (const offer of linkOffers(query(), NOW)) {
      expect(Object.keys(offer).sort()).toEqual(
        ['destCode', 'destName', 'merchant', 'originCode', 'originName', 'sourceUrl', 'tripType'].sort(),
      );
    }
  });

  /**
   * 공항이 없는 도시다 (교토·강릉). 노선을 특정할 수 없으니 줄을 안 만든다 —
   * 빈 검색 폼으로 보내느니 "못 찾았어요" 가 낫다.
   */
  it('공항 코드를 모르면 줄을 만들지 않는다', () => {
    expect(linkOffers(query({ destCode: null, destName: '교토' }), NOW)).toEqual([]);
  });

  it('노선이 그대로 주소에 들어간다', () => {
    const [trip] = linkOffers(query(), NOW);

    // 김포는 서울(sel)로, 제주는 공항 코드가 곧 도시 코드라 그대로.
    expect(trip.sourceUrl).toContain('dcity=sel');
    expect(trip.sourceUrl).toContain('acity=cju');
  });
});

/**
 * 링크가 **사용자가 말한 날짜·인원**으로 열린다. 캐시를 건드리지 않고 되는 일이다 —
 * 주소는 저장된 값이 아니라 카드를 그릴 때 다시 만들기 때문이다(0004).
 */
describe('말한 날짜·인원이 링크에 들어간다', () => {
  const trip = parseTripParams('제주 항공권 10/20~24 4명', NOW);

  it('트립닷컴', () => {
    const url = new URL(datedSearchUrl({ ...route('trip') }, NOW, trip)!);

    expect(url.searchParams.get('ddate')).toBe('2026-10-20');
    expect(url.searchParams.get('rdate')).toBe('2026-10-24');
    expect(url.searchParams.get('quantity')).toBe('4');
  });

  it('스카이스캐너', () => {
    const url = datedSearchUrl({ ...route('skyscanner') }, NOW, trip)!;

    expect(url).toContain('/gmp/cju/261020/261024/');
    expect(url).toContain('adultsv2=4');
  });

  it('마이리얼트립', () => {
    const url = new URL(datedSearchUrl({ ...route('myrealtrip') }, NOW, trip)!);

    expect(url.searchParams.get('trip')).toBe(
      'A.GMP.A.CJU.2026-10-20/A.CJU.A.GMP.2026-10-24',
    );
    expect(url.searchParams.get('adult')).toBe('4');
  });

  it('편도는 귀국 구간을 아예 빼고 연다', () => {
    const oneway = parseTripParams('제주 편도 11월 3일', NOW);
    const url = new URL(datedSearchUrl({ ...route('trip'), tripType: 'oneway' }, NOW, oneway)!);

    expect(url.searchParams.get('ddate')).toBe('2026-11-03');
    expect(url.searchParams.has('rdate')).toBe(false);
  });

  it('말하지 않았으면 내일 출발·7일 뒤 귀국·1인이다', () => {
    const url = new URL(datedSearchUrl({ ...route('trip') }, NOW, parseTripParams('제주 항공권', NOW))!);

    expect(url.searchParams.get('ddate')).toBe('2026-10-15');
    expect(url.searchParams.get('rdate')).toBe('2026-10-22');
    expect(url.searchParams.get('quantity')).toBe('1');
  });
});

function route(merchant: string) {
  return { originCode: 'GMP', destCode: 'CJU', tripType: 'round' as const, merchant };
}

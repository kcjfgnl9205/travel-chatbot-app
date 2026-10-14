import { routeAirports } from '../src/modules/flight/airports';
import { Place } from '../src/modules/places/places.types';

/**
 * 서울의 공항은 둘이다 — 국내선 김포(GMP), 국제선 인천(ICN).
 *
 * 사전은 서울의 대표 공항을 인천 하나로 들고 있어서 "제주 항공권" 이 `ICN → CJU`
 * 로 나갔다. 편수가 몇 배인 김포 노선을 통째로 못 보여준 셈이다.
 */

const FALLBACK = { name: '서울', code: 'ICN' };

function place(over: Partial<Place>): Place {
  return {
    id: 1,
    canonicalName: '서울',
    slug: 'seoul',
    countryCode: null,
    kind: 'city',
    iata: 'ICN',
    parentId: null,
    ...over,
  };
}

const SEOUL = place({});
const INCHEON = place({ id: 2, canonicalName: '인천', slug: 'incheon', iata: 'ICN' });
const BUSAN = place({ id: 3, canonicalName: '부산', slug: 'busan', iata: 'PUS' });
const JEJU = place({ id: 4, canonicalName: '제주', slug: 'jeju', iata: 'CJU' });
const OSAKA = place({ id: 5, canonicalName: '오사카', slug: 'osaka', iata: 'KIX' });

describe('항공권 출발 공항', () => {
  it('국내선이면 출발지를 말하지 않아도 김포다', () => {
    expect(routeAirports(null, JEJU, FALLBACK)).toEqual({ originCode: 'GMP', destCode: 'CJU' });
  });

  it('해외면 인천이다', () => {
    expect(routeAirports(null, OSAKA, FALLBACK)).toEqual({ originCode: 'ICN', destCode: 'KIX' });
  });

  it('"서울에서" 라고 말해도 국내선이면 김포다', () => {
    expect(routeAirports(SEOUL, JEJU, FALLBACK).originCode).toBe('GMP');
  });

  it('"인천에서" 는 공항을 콕 집은 말이라 국내선이어도 그대로 둔다', () => {
    expect(routeAirports(INCHEON, JEJU, FALLBACK).originCode).toBe('ICN');
  });

  it('도착지가 서울인 국내선도 김포로 내린다', () => {
    expect(routeAirports(BUSAN, SEOUL, FALLBACK)).toEqual({ originCode: 'PUS', destCode: 'GMP' });
  });

  it('서울이 아닌 출발지는 손대지 않는다', () => {
    expect(routeAirports(BUSAN, OSAKA, FALLBACK)).toEqual({ originCode: 'PUS', destCode: 'KIX' });
  });

  // ⚠️ 모르면 해외로 친다. 국내인 줄 몰라 인천으로 나가면 "노선이 적다" 지만,
  //    해외인데 김포로 나가면 노선이 아예 없는 공항으로 검색이 나간다.
  it('사전에 없고 DB 에도 나라가 없으면 인천이다', () => {
    const unknown = place({ id: 6, canonicalName: '어딘가', slug: 'nowhere', iata: 'XXX' });
    expect(routeAirports(null, unknown, FALLBACK).originCode).toBe('ICN');
  });

  it('사전에 없어도 DB 가 KR 이라고 하면 김포다', () => {
    const chuncheon = place({
      id: 7,
      canonicalName: '춘천',
      slug: 'chuncheon',
      iata: 'WJU',
      countryCode: 'KR',
    });
    expect(routeAirports(null, chuncheon, FALLBACK).originCode).toBe('GMP');
  });

  it('기본 출발지를 부산으로 바꿔두면 국내선도 그대로 부산이다', () => {
    expect(routeAirports(null, JEJU, { name: '부산', code: 'PUS' }).originCode).toBe('PUS');
  });
});

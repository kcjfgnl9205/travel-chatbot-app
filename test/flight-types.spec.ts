import { Flight } from '../src/modules/flight/flight.types';
import {
  cabinText,
  dateLabel,
  flightKey,
  isFlight,
  isoDate,
  legText,
  listRowDescription,
  listRowTitle,
  priceText,
  stopsText,
} from '../src/modules/flight/flight.types';
import { itemLabel } from '../src/modules/flight/flight.service';
import * as t from '../src/modules/kakao/templates';

function flight(over: Partial<Flight> = {}): Flight {
  return {
    airline: '대한항공',
    flightNo: 'KE723',
    originCode: 'ICN',
    originName: '인천',
    destCode: 'KIX',
    destName: '오사카',
    departDate: '2026-10-03',
    departTime: '09:20',
    arriveTime: '11:00',
    durationMinutes: 100,
    stops: 0,
    tripType: 'oneway',
    priceFrom: 289000,
    currency: 'KRW',
    sourceUrl: 'https://kr.trip.com/flights/osaka-1',
    merchant: 'trip',
    ...over,
  };
}

describe('항공권 카드 문구', () => {
  describe('listCard 한 줄', () => {
    it('제목에 가격을 둔다 — 항공편을 고르는 첫 번째 축이다', () => {
      expect(listRowTitle(flight())).toBe('대한항공 KE723 · 289,000원');
      expect(listRowTitle(flight()).length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_TITLE);
    });

    it('설명은 40자를 넘지 않는다 — 넘기면 말풍선이 통째로 안 보인다', () => {
      const round = listRowDescription(
        flight({
          tripType: 'round',
          returnDate: '2026-10-06',
          returnDepartTime: '12:30',
          stops: 1,
          via: '홍콩',
        }),
      );
      expect(round.length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_DESC);
      expect(round).toContain('↔');
    });

    it('날짜를 모르면 그 자리를 비운다 — 지어내지 않는다', () => {
      // ⚠️ 라우터는 날짜를 검색에 넘기지 않는다. provider 가 날짜를 못 주는 게 정상이다.
      const text = listRowDescription(flight({ departDate: null, departTime: null }));
      expect(text).not.toContain('undefined');
      expect(text).toContain('직항');
    });
  });

  describe('표기', () => {
    it('요일은 서버 시간대와 무관하게 같다', () => {
      // 2026-10-03 은 토요일. 지역 시간대로 파싱하면 하루씩 밀린다.
      expect(dateLabel('2026-10-03')).toBe('10/3(토)');
      expect(dateLabel('2026-01-01')).toBe('1/1(목)');
    });

    it('날짜가 없거나 형식이 아니면 빈 문자열', () => {
      expect(dateLabel(null)).toBe('');
      expect(dateLabel('다음달 3일')).toBe('');
      expect(dateLabel('2026-13-45')).toBe('');
    });

    it('없는 날짜는 통과시키지 않는다', () => {
      expect(isoDate('2026-10-03')).toBe('2026-10-03');
      // Date 가 3월 2일로 조용히 굴려버리는 값이다.
      expect(isoDate('2026-02-30')).toBeNull();
      expect(isoDate('내일')).toBeNull();
    });

    it('경유', () => {
      expect(stopsText(flight({ stops: 0 }))).toBe('직항');
      expect(stopsText(flight({ stops: 1, via: '홍콩' }))).toBe('1회 경유 (홍콩)');
      expect(stopsText(flight({ stops: 1, via: null }))).toBe('1회 경유');
      // 모르면 빈 문자열 — '0회 경유' 처럼 지어내지 않는다.
      expect(stopsText(flight({ stops: null }))).toBe('');
    });

    it('구간 한 줄', () => {
      expect(legText('2026-10-03', '09:20', '11:00')).toBe('10/3(토) 09:20→11:00');
    });

    it('가격을 모르면 지어내지 않는다', () => {
      expect(priceText(flight({ priceFrom: null }))).toBe('가격 문의');
      expect(priceText(flight({ priceFrom: 289000 }))).toBe('289,000원');
    });

    it('좌석 등급은 한국어로', () => {
      expect(cabinText('business')).toBe('비즈니스');
      // 모르는 값은 그대로 둔다 — 버리면 정보가 사라진다.
      expect(cabinText('suite')).toBe('suite');
    });
  });

  describe('신원', () => {
    it('같은 편은 표기가 달라도 같은 키다', () => {
      expect(flightKey(flight({ flightNo: 'ke723' }))).toBe(flightKey(flight()));
    });

    it('주소가 같아도 다른 편이면 다른 키다 — 항공권은 주소를 공유한다', () => {
      const a = flight({ flightNo: 'KE723', departTime: '09:20' });
      const b = flight({ flightNo: 'KE725', departTime: '14:20' });
      expect(a.sourceUrl).toBe(b.sourceUrl);
      expect(flightKey(a)).not.toBe(flightKey(b));
    });

    it('DB·로그에 남는 이름', () => {
      expect(itemLabel(flight())).toBe('대한항공 KE723 ICN→KIX');
    });
  });

  describe('저장된 값을 살려낼 때', () => {
    it('항공권 모양이면 통과', () => {
      expect(isFlight(flight())).toBe(true);
    });

    it('필드가 빠졌으면 버린다 — 배포로 모양이 바뀔 수 있다', () => {
      expect(isFlight({ airline: '대한항공' })).toBe(false);
      expect(isFlight({ ...flight(), originCode: undefined })).toBe(false);
      expect(isFlight(null)).toBe(false);
      expect(isFlight('대한항공')).toBe(false);
    });
  });
});

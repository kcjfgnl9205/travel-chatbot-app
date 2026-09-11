import { Flight, FlightQuery } from '../src/modules/flight/flight.types';
import {
  cabinText,
  cardRows,
  dateLabel,
  durationText,
  flightKey,
  isFlight,
  legText,
  priceText,
  stopsText,
} from '../src/modules/flight/flight.types';
import { cardHead, introText, itemLabel, priceSummary } from '../src/modules/flight/flight.service';
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

function query(over: Partial<FlightQuery> = {}): FlightQuery {
  return {
    originSlug: 'seoul',
    originName: '서울',
    originCode: 'ICN',
    destSlug: 'osaka',
    destName: '오사카',
    destCode: 'KIX',
    departDate: '2026-10-03',
    returnDate: null,
    tripType: 'oneway',
    passengers: null,
    cabin: null,
    limit: 5,
    originAssumed: false,
    ...over,
  };
}

describe('항공권 카드 문구', () => {
  describe('제한을 넘기면 말풍선이 통째로 안 보인다', () => {
    it('itemList 는 5줄을 넘지 않는다 — 왕복 + 좌석등급이 다 있어도', () => {
      const rows = cardRows(
        flight({
          tripType: 'round',
          returnDate: '2026-10-06',
          returnDepartTime: '12:30',
          returnArriveTime: '14:20',
          cabin: 'business',
        }),
      );
      expect(rows.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_ROWS);
      for (const row of rows) {
        expect(row.title.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_TITLE);
        expect(row.description.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_DESC);
      }
    });

    it('itemCard 빌더가 초과분을 자른다', () => {
      const card = t.itemCard({
        headTitle: '가'.repeat(50),
        itemList: Array.from({ length: 9 }, () => ({
          title: '아주긴제목입니다',
          description: '설명'.repeat(30),
        })),
        summary: { title: '아주긴요약제목', description: '1' },
      }) as any;

      expect(card.head.title.length).toBe(t.MAX_ITEM_CARD_HEAD);
      expect(card.itemList).toHaveLength(t.MAX_ITEM_LIST_ROWS);
      expect(card.itemList[0].title.length).toBe(t.MAX_ITEM_LIST_TITLE);
      expect(card.itemList[0].description.length).toBe(t.MAX_ITEM_LIST_DESC);
      expect(card.itemListSummary.title.length).toBe(t.MAX_ITEM_LIST_TITLE);
    });

    it('값이 없는 줄은 만들지 않는다 — 빈 description 이 있으면 카드가 안 보인다', () => {
      const rows = cardRows(
        flight({ departTime: null, arriveTime: null, departDate: null, durationMinutes: null, stops: null }),
      );
      expect(rows).toEqual([{ title: '항공사', description: '대한항공 KE723' }]);
    });
  });

  describe('편도/왕복', () => {
    it('왕복이면 가는편·오는편이 갈린다', () => {
      const rows = cardRows(
        flight({
          tripType: 'round',
          returnDate: '2026-10-06',
          returnDepartTime: '12:30',
          returnArriveTime: '14:20',
        }),
      );
      const titles = rows.map((r) => r.title);
      expect(titles).toContain('가는편');
      expect(titles).toContain('오는편');
    });

    it('편도면 일정 한 줄이고 오는편이 없다', () => {
      const titles = cardRows(flight()).map((r) => r.title);
      expect(titles).toContain('일정');
      expect(titles).not.toContain('오는편');
    });

    it('왕복인데 오는편 시각을 모르면 그 줄만 빠진다', () => {
      const titles = cardRows(flight({ tripType: 'round' })).map((r) => r.title);
      expect(titles).not.toContain('오는편');
      expect(titles).toContain('가는편');
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

    it('소요 시간', () => {
      expect(durationText(145)).toBe('2시간 25분');
      expect(durationText(120)).toBe('2시간');
      expect(durationText(45)).toBe('45분');
    });

    it('경유', () => {
      expect(stopsText(flight({ stops: 0 }))).toBe('직항');
      expect(stopsText(flight({ stops: 1, via: '홍콩' }))).toBe('1회 경유 (홍콩)');
      expect(stopsText(flight({ stops: 1, via: null }))).toBe('1회 경유');
      // 모르면 빈 문자열 — '0회 경유' 처럼 지어내지 않는다.
      expect(stopsText(flight({ stops: null }))).toBe('');
    });

    it('구간 한 줄은 20자 안에 날짜·출발·도착이 다 들어간다', () => {
      const text = legText('2026-10-03', '09:20', '11:00');
      expect(text).toBe('10/3(토) 09:20→11:00');
      expect(text.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_DESC);
    });

    it('가격을 모르면 지어내지 않는다', () => {
      expect(priceText(flight({ priceFrom: null }))).toBe('가격 문의');
      expect(priceText(flight({ priceFrom: 289000 }))).toBe('289,000원');
    });

    it('인원이 여럿이면 1인 기준임을 밝힌다', () => {
      expect(priceSummary(flight(), query({ passengers: 2 }))).toBe('1인 289,000원');
      expect(priceSummary(flight(), query({ passengers: 1 }))).toBe('289,000원');
      expect(priceSummary(flight(), query())).toBe('289,000원');
    });

    it('좌석 등급은 한국어로', () => {
      expect(cabinText('business')).toBe('비즈니스');
      // 모르는 값은 그대로 둔다 — 버리면 정보가 사라진다.
      expect(cabinText('suite')).toBe('suite');
    });

    it('카드 머리글은 노선과 날짜', () => {
      expect(cardHead(flight(), query())).toBe('인천 → 오사카 · 10/3(토)');
      expect(cardHead(flight({ departDate: null }), query({ departDate: null }))).toBe(
        '인천 → 오사카',
      );
    });
  });

  describe('안내 말풍선', () => {
    it('가격 주의를 항상 넣는다 — 실시간 운임이 아니다', () => {
      expect(introText(query(), 3)).toContain('검색 시점 기준');
    });

    it('출발지를 추측했으면 알려주고, 아니면 말하지 않는다', () => {
      expect(introText(query({ originAssumed: true }), 3)).toContain('서울 출발 기준');
      expect(introText(query({ originAssumed: false }), 3)).not.toContain('출발 기준이에요');
    });

    it('조건을 그대로 되읽어준다', () => {
      const text = introText(
        query({ tripType: 'round', returnDate: '2026-10-06', passengers: 2, cabin: 'business' }),
        4,
      );
      expect(text).toContain('왕복');
      expect(text).toContain('가는 날 10/3(토)');
      expect(text).toContain('오는 날 10/6(화)');
      expect(text).toContain('2명');
      expect(text).toContain('비즈니스');
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

  describe('캐시에서 살려낼 때', () => {
    it('항공권 모양이면 통과', () => {
      expect(isFlight(flight())).toBe(true);
    });

    it('필드가 빠졌으면 미스로 떨어뜨린다 — 배포로 모양이 바뀔 수 있다', () => {
      expect(isFlight({ airline: '대한항공' })).toBe(false);
      expect(isFlight({ ...flight(), originCode: undefined })).toBe(false);
      expect(isFlight(null)).toBe(false);
      expect(isFlight('대한항공')).toBe(false);
    });
  });
});

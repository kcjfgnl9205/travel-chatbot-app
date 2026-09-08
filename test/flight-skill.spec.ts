import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import { FlightService } from '../src/modules/flight/flight.service';
import { FlightNluService } from '../src/modules/nlu/flight-nlu.service';
import { SearchCacheService } from '../src/modules/search-cache/search-cache.service';
import * as t from '../src/modules/kakao/templates';
import { FakeFlightProvider } from './fake-flight-provider';
import {
  FLIGHTS,
  callbackReceiver,
  createApp,
  itemCardsOf,
  kakaoPayload,
  searchUntilCards,
} from './helpers';

describe('카카오 항공권 스킬', () => {
  let app: INestApplication;
  let provider: FakeFlightProvider;
  let memory: MemoryStoreService;
  let cache: SearchCacheService;
  let flights: FlightService;
  let nlu: FlightNluService;

  beforeAll(async () => {
    ({ app, flightProvider: provider } = await createApp());
    memory = app.get(MemoryStoreService);
    cache = app.get(SearchCacheService);
    flights = app.get(FlightService);
    nlu = app.get(FlightNluService);
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    memory.clear();
    cache.clearMemory();
    flights.forgetEmpty();
    nlu.clearCache();
    provider.reset();
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(FLIGHTS).send(body);

  const textOf = (body: any) => body.template?.outputs?.[0]?.simpleText?.text ?? '';

  // ------------------------------------------------------------ 5초 예산
  describe('캐시 미스는 요청 경로에서 검색하지 않는다', () => {
    it('콜백이 없으면 "찾고 있어요" 로 넘기고 백그라운드에서 검색한다', async () => {
      const res = await post(kakaoPayload('오사카 항공권 찾아줘')).expect(201);

      expect(itemCardsOf(res.body)).toBeUndefined();
      expect(textOf(res.body)).toContain('찾고 있어요');

      // 검색은 시작됐다 — 다시 물으면 캐시에서 카드가 나온다.
      const cards = await searchUntilCards(app, '오사카 항공권 찾아줘');
      expect(cards[0].head.title).toContain('오사카');
    });

    it('응답이 5초 예산 안에 떨어진다 — provider 가 아무리 느려도', async () => {
      provider.delayMs = 3000; // AI 검색이 느린 상황

      const started = Date.now();
      const res = await post(kakaoPayload('방콕 항공권 찾아줘')).expect(201);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1000);
      expect(textOf(res.body)).toContain('찾고 있어요');
    });

    it('같은 노선을 동시에 물어도 검색은 한 번만 나간다', async () => {
      provider.delayMs = 200;

      await Promise.all(
        Array.from({ length: 5 }, () => post(kakaoPayload('다낭 항공권 찾아줘'))),
      );
      await searchUntilCards(app, '다낭 항공권 찾아줘');

      expect(provider.calls.filter((c) => c.destSlug === 'danang')).toHaveLength(1);
    });

    it('빈손으로 끝난 노선을 연타해도 검색은 한 번만 나간다', async () => {
      // 빈 결과는 캐시에 안 남는다. 그것만 두면 오타 연타가 그대로 OpenAI 요금이 된다.
      provider.reply = () => [];

      for (let i = 0; i < 4; i += 1) {
        await post(kakaoPayload('asdf 항공권 찾아줘')).expect(201);
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(provider.calls.filter((c) => c.destSlug === 'asdf')).toHaveLength(1);
    });

    it('캐시에 있으면 provider 를 아예 안 부른다', async () => {
      await searchUntilCards(app, '오사카 항공권 찾아줘');
      const before = provider.calls.length;

      const res = await post(kakaoPayload('오사카 항공권 찾아줘')).expect(201);
      expect(itemCardsOf(res.body)).toBeDefined();
      expect(provider.calls).toHaveLength(before);
    });

    it('날짜가 다르면 다른 검색이다 — 캐시 키에 날짜가 들어간다', async () => {
      await searchUntilCards(app, '2026-10-03 오사카 항공권');
      await searchUntilCards(app, '2026-11-20 오사카 항공권');

      const departs = provider.calls.map((c) => c.departDate);
      expect(departs).toContain('2026-10-03');
      expect(departs).toContain('2026-11-20');
    });
  });

  // ------------------------------------------------------------ 콜백 경로
  describe('콜백이 켜져 있으면 카드를 밀어준다', () => {
    it('useCallback 을 먼저 주고, 검색이 끝나면 캐러셀을 POST 한다', async () => {
      const receiver = await callbackReceiver();
      try {
        const res = await post(
          kakaoPayload('오사카 왕복 항공권 2명', 'cb-user', {}, receiver.url),
        ).expect(201);

        expect(res.body.useCallback).toBe(true);
        expect(res.body.data.text).toContain('찾고 있어요');

        const delivered = await receiver.received;
        const cards = itemCardsOf(delivered);
        // provider 가 주는 6편이 그대로 온다 (캐러셀 한계 10장 안이다).
        expect(cards).toHaveLength(6);
        expect(cards[0].itemList.some((r: any) => r.title === '오는편')).toBe(true);
      } finally {
        await receiver.close();
      }
    });
  });

  // ------------------------------------------------------------ 카드 모양
  describe('itemCard 캐러셀 — 카카오 제한을 넘기면 말풍선이 통째로 안 보인다', () => {
    it('안내 말풍선 + 캐러셀 두 개를 보낸다', async () => {
      const cards = await searchUntilCards(app, '오사카 왕복 항공권 2명');
      const res = await post(kakaoPayload('오사카 왕복 항공권 2명')).expect(201);

      expect(res.body.template.outputs).toHaveLength(2);
      expect(res.body.template.outputs[0].simpleText).toBeDefined();
      expect(res.body.template.outputs[1].carousel.type).toBe('itemCard');
      expect(cards.length).toBeGreaterThan(0);
    });

    it('모든 줄이 길이 제한 안에 있다', async () => {
      const cards = await searchUntilCards(app, '오사카 왕복 항공권 2명');

      for (const card of cards) {
        expect(card.head.title.length).toBeLessThanOrEqual(t.MAX_ITEM_CARD_HEAD);
        expect(card.itemList.length).toBeGreaterThan(0);
        expect(card.itemList.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_ROWS);
        expect(card.buttons.length).toBeLessThanOrEqual(t.MAX_ITEM_CARD_BUTTONS);

        for (const row of card.itemList) {
          expect(row.title.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_TITLE);
          expect(row.description.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_DESC);
          // 빈 값이 있으면 카카오가 카드를 렌더링하지 않는다.
          expect(row.description.length).toBeGreaterThan(0);
        }
        expect(card.itemListSummary.title.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_TITLE);
        expect(card.itemListSummary.description.length).toBeLessThanOrEqual(
          t.MAX_ITEM_LIST_DESC,
        );
      }
    });

    it('캐러셀 카드 수 제한을 넘기지 않는다', async () => {
      provider.reply = (query) =>
        Array.from({ length: 20 }, (_, i) => ({
          airline: `항공사${i}`,
          flightNo: `AA${100 + i}`,
          originCode: 'ICN',
          destCode: 'KIX',
          destName: query.destName,
          departTime: '09:00',
          arriveTime: '11:00',
          tripType: query.tripType,
          priceFrom: 100000 + i,
          sourceUrl: `https://kr.trip.com/flights/x-${i}`,
        }));

      const cards = await searchUntilCards(app, '오사카 항공권 찾아줘');
      expect(cards).toHaveLength(t.MAX_CAROUSEL_ITEMS);
    });

    it('편도면 오는편 줄이 없다', async () => {
      const cards = await searchUntilCards(app, '2026-10-03 오사카 편도 항공권');
      for (const card of cards) {
        expect(card.itemList.map((r: any) => r.title)).not.toContain('오는편');
      }
    });

    it('같은 편이 두 번 오면 하나만 나간다 — 주소가 아니라 편명으로 판정한다', async () => {
      // 항공권은 여러 편이 같은 노선 검색 페이지를 가리킨다. 주소로 중복을 지우면
      // 카드가 한 장만 남는다.
      provider.reply = (query) =>
        [1, 1, 2].map((n) => ({
          airline: '대한항공',
          flightNo: `KE70${n}`,
          originCode: 'ICN',
          destCode: 'KIX',
          destName: query.destName,
          departTime: `0${n}:00`,
          arriveTime: '11:00',
          tripType: query.tripType,
          priceFrom: 200000,
          sourceUrl: 'https://kr.trip.com/flights/osaka', // 세 편이 같은 주소
        }));

      const cards = await searchUntilCards(app, '오사카 항공권 찾아줘');
      expect(cards).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------ 안내 문구
  describe('안내 말풍선 — 사용자가 조건을 확인하고 고칠 수 있어야 한다', () => {
    it('가격이 확정 운임이 아니라는 걸 알린다', async () => {
      await searchUntilCards(app, '오사카 항공권 찾아줘');
      const res = await post(kakaoPayload('오사카 항공권 찾아줘')).expect(201);
      expect(textOf(res.body)).toContain('검색 시점 기준');
    });

    it('출발지를 안 말했으면 서울 출발이라고 알려준다', async () => {
      await searchUntilCards(app, '오사카 항공권 찾아줘');
      const res = await post(kakaoPayload('오사카 항공권 찾아줘')).expect(201);

      expect(textOf(res.body)).toContain('서울 출발 기준');
      expect(provider.calls[0].originCode).toBe('ICN');
      expect(provider.calls[0].originAssumed).toBe(true);
    });

    it('출발지를 말했으면 추측했다고 하지 않는다', async () => {
      await searchUntilCards(app, '부산에서 오사카 항공권');
      const res = await post(kakaoPayload('부산에서 오사카 항공권')).expect(201);

      expect(textOf(res.body)).not.toContain('출발 기준이에요');
      expect(provider.calls[0].originName).toBe('부산');
      expect(provider.calls[0].destSlug).toBe('osaka');
    });
  });

  // ------------------------------------------------------------ 되묻기
  it('목적지를 못 알아들으면 되묻는다', async () => {
    const res = await post(kakaoPayload('항공권 알려줘')).expect(201);
    expect(textOf(res.body)).toContain('어디로 가는 항공권');
    expect(provider.calls).toHaveLength(0);
  });

  it('빈 발화도 200 으로 되묻는다', async () => {
    const res = await post(kakaoPayload('')).expect(201);
    expect(textOf(res.body)).toContain('어디로 가는 항공권');
  });

  it('페이로드가 비어도 500 을 내지 않는다 — 카카오에 500 을 주면 원인 불명 오류만 뜬다', async () => {
    const res = await request(app.getHttpServer()).post(FLIGHTS).send({}).expect(201);
    expect(textOf(res.body)).toBeTruthy();
  });

  // ------------------------------------------------------------ 클릭 추적
  it('카드 버튼은 /r/{clickId} 를 가리키고, 누르면 예약 페이지로 302 한다', async () => {
    const cards = await searchUntilCards(app, '오사카 항공권 찾아줘');
    const url = cards[0].buttons[0].webLinkUrl;

    expect(url).toMatch(/\/r\/[\w-]{12}$/);
    const clickId = url.split('/r/')[1];

    const res = await request(app.getHttpServer()).get(`/r/${clickId}`).expect(302);
    expect(res.headers.location).toContain('trip.com');

    // 클릭이 실제로 기록됐는가 (DB 가 없으면 인메모리 폴백).
    expect(memory.get(clickId)?.clickCount).toBe(1);
    expect(memory.get(clickId)?.itemName).toContain('대한항공');
  });

  // ------------------------------------------------------------ 퀵리플라이
  it('퀵리플라이는 카카오 제한 안에 있고, 이미 본 도시는 빼준다', async () => {
    const res = await post(kakaoPayload('오사카 항공권 찾아줘')).expect(201);
    const quick = res.body.template.quickReplies;

    expect(quick.length).toBeLessThanOrEqual(t.MAX_QUICK_REPLIES);
    for (const reply of quick) {
      expect(reply.label.length).toBeLessThanOrEqual(t.MAX_QUICK_REPLY_LABEL);
    }
    expect(quick.map((q: any) => q.label)).not.toContain('오사카 항공권');
  });
});

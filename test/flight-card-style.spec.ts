import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { ATTRACTION_PROVIDER } from '../src/modules/attraction/attraction.types';
import { FLIGHT_PROVIDER } from '../src/modules/flight/flight.types';
import { HOTEL_PROVIDER } from '../src/modules/hotel/hotel.types';
import { OpenAiService } from '../src/modules/openai/openai.service';
import * as t from '../src/modules/kakao/templates';
import { FakeAttractionProvider } from './fake-attraction-provider';
import { FakeFlightProvider } from './fake-flight-provider';
import { FakeHotelProvider } from './fake-provider';
import { FakeOpenAiService } from './fake-openai';
import { FLIGHTS, itemCardsOf, kakaoPayload } from './helpers';

/**
 * FLIGHT_CARD_STYLE 탈출구.
 *
 * 기본은 listCard 다 — **그룹챗봇(팀톡방)이 itemCard 를 못 그려서 말풍선이 통째로
 * 사라지기 때문이다.** 하지만 itemCard 는 정보 밀도가 훨씬 높고(항공사·가는편·
 * 오는편·소요·좌석 5줄 + 강조된 가격), 일반 채널 챗봇에서는 정상 동작한다.
 *
 * 그래서 코드를 지우지 않고 설정으로 남겼다. 이 파일은 **그 탈출구가 실제로
 * 살아 있는지**만 지킨다 — 되돌릴 수 없는 탈출구는 없는 것과 같다.
 */
describe('FLIGHT_CARD_STYLE=carousel — 채널 챗봇용 탈출구', () => {
  let app: INestApplication;
  let provider: FakeFlightProvider;
  const saved = process.env.FLIGHT_CARD_STYLE;

  beforeAll(async () => {
    process.env.FLIGHT_CARD_STYLE = 'carousel';
    provider = new FakeFlightProvider();

    // 설정은 부팅 시 한 번 읽으므로 앱을 새로 세워야 한다.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FLIGHT_PROVIDER)
      .useValue(provider)
      .overrideProvider(HOTEL_PROVIDER)
      .useValue(new FakeHotelProvider())
      .overrideProvider(ATTRACTION_PROVIDER)
      .useValue(new FakeAttractionProvider())
      .overrideProvider(OpenAiService)
      .useValue(new FakeOpenAiService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLIGHT_CARD_STYLE;
    else process.env.FLIGHT_CARD_STYLE = saved;
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(FLIGHTS).send(body);

  /** 캐시 미스는 바로 카드를 주지 않는다. 나올 때까지 다시 묻는다. */
  const untilCards = async (utterance: string): Promise<any[]> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await post(kakaoPayload(utterance));
      const cards = itemCardsOf(res.body);
      if (cards) return cards;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`itemCard 캐러셀이 나오지 않았다: ${utterance}`);
  };

  it('설정을 켜면 itemCard 캐러셀로 돌아간다', async () => {
    const cards = await untilCards('오사카 왕복 항공권 2명');
    const res = await post(kakaoPayload('오사카 왕복 항공권 2명')).expect(201);

    expect(res.body.template.outputs[1].carousel.type).toBe('itemCard');
    expect(res.body.template.outputs[1].listCard).toBeUndefined();
    expect(cards.length).toBeGreaterThan(0);
  });

  it('listCard 가 못 담던 정보가 그대로 있다 — 이게 탈출구를 남긴 이유다', async () => {
    const cards = await untilCards('오사카 왕복 항공권 2명');
    const titles = cards[0].itemList.map((r: any) => r.title);

    expect(titles).toContain('가는편');
    expect(titles).toContain('오는편'); // listCard 한 줄에는 둘 다 안 들어간다
    expect(cards[0].itemListSummary.title).toBe('예상가');
  });

  it('카드 수 한계가 listCard(5) 가 아니라 캐러셀(10) 이다', async () => {
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

    const cards = await untilCards('방콕 항공권 찾아줘');
    expect(cards).toHaveLength(t.MAX_CAROUSEL_ITEMS);
  });

  it('itemCard 제한도 그대로 지킨다', async () => {
    provider.reset();
    const cards = await untilCards('다낭 왕복 항공권');
    for (const card of cards) {
      expect(card.head.title.length).toBeLessThanOrEqual(t.MAX_ITEM_CARD_HEAD);
      expect(card.itemList.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_ROWS);
      for (const row of card.itemList) {
        expect(row.title.length).toBeLessThanOrEqual(t.MAX_ITEM_LIST_TITLE);
        expect(row.description.length).toBeGreaterThan(0);
      }
    }
  });
});

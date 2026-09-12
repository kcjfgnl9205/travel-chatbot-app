import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import { HotelService } from '../src/modules/hotel/hotel.service';
import { NluService } from '../src/modules/nlu/nlu.service';
import { SearchCacheService } from '../src/modules/search-cache/search-cache.service';
import * as t from '../src/modules/kakao/templates';
import { FakeHotelProvider, defaultHotels } from './fake-provider';
import {
  RECOMMEND,
  callbackReceiver,
  createApp,
  kakaoPayload,
  listCardOf,
  recommendUntilCard,
} from './helpers';

describe('카카오 호텔 스킬', () => {
  let app: INestApplication;
  let provider: FakeHotelProvider;
  let memory: MemoryStoreService;
  let cache: SearchCacheService;
  let hotels: HotelService;
  let nlu: NluService;

  beforeAll(async () => {
    ({ app, provider } = await createApp());
    memory = app.get(MemoryStoreService);
    cache = app.get(SearchCacheService);
    hotels = app.get(HotelService);
    nlu = app.get(NluService);
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    memory.clear();
    cache.clearMemory();
    hotels.forgetEmpty();
    nlu.clearCache();
    provider.reset();
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(RECOMMEND).send(body);

  const textOf = (body: any) => body.template?.outputs?.[0]?.simpleText?.text ?? '';

  it('앱 생존 확인', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('/health 는 환경변수만 본다. 실제 연결 여부는 /health/db 가 판단한다', async () => {
    const res = await request(app.getHttpServer()).get('/health/db').expect(503);
    expect(res.body.status).toBe('disabled');
    expect(res.body.reason).toContain('SUPABASE_URL');
  });

  // ------------------------------------------------------------ 5초 예산
  describe('캐시 미스는 요청 경로에서 검색하지 않는다', () => {
    it('콜백이 없으면 "찾고 있어요" 로 넘기고 백그라운드에서 검색한다', async () => {
      const res = await post(kakaoPayload('방콕 호텔 추천해줘')).expect(201);

      expect(listCardOf(res.body)).toBeUndefined();
      expect(textOf(res.body)).toContain('찾고 있어요');

      // 검색은 시작됐다 — 다시 물으면 캐시에서 카드가 나온다.
      const card = await recommendUntilCard(app, '방콕 호텔 추천해줘');
      expect(card.header.title).toContain('방콕');
    });

    it('응답이 5초 예산 안에 떨어진다 — provider 가 아무리 느려도', async () => {
      provider.delayMs = 3000; // AI 검색이 느린 상황

      const started = Date.now();
      const res = await post(kakaoPayload('이스탄불 호텔 추천해줘')).expect(201);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1000);
      expect(textOf(res.body)).toContain('찾고 있어요');
    });

    it('같은 도시를 동시에 물어도 검색은 한 번만 나간다', async () => {
      provider.delayMs = 200;

      await Promise.all(
        Array.from({ length: 5 }, () => post(kakaoPayload('하노이 호텔 추천해줘'))),
      );
      await recommendUntilCard(app, '하노이 호텔 추천해줘');

      const hanoi = provider.calls.filter((c) => c.cityName === '하노이');
      expect(hanoi).toHaveLength(1);
    });

    it('빈손으로 끝난 도시를 연타해도 검색은 두 번에서 멈춘다', async () => {
      // 빈 결과는 캐시에 안 남는다. 그것만 두면 오타 연타가 그대로 OpenAI 요금이 된다.
      // ⚠️ 두 번인 이유: 한 번으로 굳히면 **모델이 한 번 헛돈 게 10분짜리 장애**가 된다.
      //    실제로 "도쿄 호텔" 이 그래서 10분 동안 "찾지 못했어요" 만 나왔다.
      provider.reply = () => [];

      for (let i = 0; i < 5; i += 1) {
        const res = await post(kakaoPayload('asdf 호텔 추천해줘')).expect(201);
        expect(textOf(res.body)).toBeTruthy();
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(provider.calls.filter((c) => c.cityName === 'asdf')).toHaveLength(2);
    });

    it('한 번 비었다고 바로 굳히지 않는다 — 두 번째는 다시 찾아본다', async () => {
      // 첫 번째만 비고 두 번째에 결과가 나오는 상황(모델 변동성)을 흉내 낸다.
      let attempt = 0;
      provider.reply = (query) => (attempt++ === 0 ? [] : defaultHotels(query));

      await post(kakaoPayload('zxcv 호텔 추천해줘')).expect(201);
      await new Promise((r) => setTimeout(r, 50));

      // 굳었다면 여기서 검색조차 안 하고 "찾지 못했어요" 가 나온다.
      const card = await recommendUntilCard(app, 'zxcv 호텔 추천해줘');
      expect(card.items.length).toBeGreaterThan(0);
    });

    it('두 번 다 비면 그때는 굳는다 — 진짜 없는 도시다', async () => {
      provider.reply = () => [];
      for (let i = 0; i < 2; i += 1) {
        await post(kakaoPayload('zxcv 호텔 추천해줘')).expect(201);
        await new Promise((r) => setTimeout(r, 50));
      }

      const before = provider.calls.length;
      const res = await post(kakaoPayload('zxcv 호텔 추천해줘')).expect(201);
      expect(textOf(res.body)).toContain('찾지 못했어요');
      expect(provider.calls).toHaveLength(before); // 검색을 안 했다
    });

    it('캐시에 있으면 provider 를 아예 안 부른다', async () => {
      await recommendUntilCard(app, '오사카 호텔 추천해줘');
      const before = provider.calls.length;

      const res = await post(kakaoPayload('오사카 호텔 추천해줘')).expect(201);
      expect(listCardOf(res.body)).toBeDefined();
      expect(provider.calls).toHaveLength(before);
    });
  });

  // -------------------------------------------------------------- 콜백
  describe('콜백', () => {
    it('콜백이 켜져 있으면 useCallback 으로 답하고 카드를 밀어준다', async () => {
      const receiver = await callbackReceiver();
      try {
        const res = await post(
          kakaoPayload('세부 호텔 추천해줘', 'test-user', {}, receiver.url),
        ).expect(201);

        // 즉시 응답은 예약 알림이다
        expect(res.body.useCallback).toBe(true);
        expect(res.body.version).toBe('2.0');
        expect(res.body.data.text).toContain('세부');

        // 진짜 카드는 콜백으로 온다
        const delivered = await receiver.received;
        const card = listCardOf(delivered);
        expect(card.header.title).toContain('세부');
        expect(card.items).toHaveLength(5);
        expect(card.items[0].link.web).toContain('/r/');
      } finally {
        await receiver.close();
      }
    });

    it('검색이 실패해도 콜백으로 안내는 간다', async () => {
      const receiver = await callbackReceiver();
      provider.reply = () => {
        throw new Error('openai 폭발');
      };
      try {
        await post(kakaoPayload('리스본 호텔 추천해줘', 'test-user', {}, receiver.url)).expect(201);

        const delivered = await receiver.received;
        expect(delivered.template.outputs[0].simpleText.text).toContain('문제가 생겼어요');
      } finally {
        await receiver.close();
      }
    });

    it('결과가 없으면 콜백으로 못 찾았다고 알린다', async () => {
      const receiver = await callbackReceiver();
      provider.reply = () => [];
      try {
        await post(kakaoPayload('없는도시 호텔 추천해줘', 'test-user', {}, receiver.url)).expect(
          201,
        );

        const delivered = await receiver.received;
        expect(delivered.template.outputs[0].simpleText.text).toContain('찾지 못했어요');
      } finally {
        await receiver.close();
      }
    });
  });

  // ---------------------------------------------------------- 카드 조립
  describe('카드', () => {
    it('listCard 를 돌려준다', async () => {
      const card = await recommendUntilCard(app, '오사카 호텔 추천해줘');

      expect(card.header.title).toContain('오사카');
      expect(card.items).toHaveLength(5); // provider 는 6곳을 줬지만 5줄이 상한

      const row = card.items[0];
      expect(row.title).toBeTruthy();
      expect(row.description).toMatch(/^1박 /);
      expect(row.imageUrl).toMatch(/^https:\/\//);
      // 줄 전체 링크가 애드픽이 아니라 우리 리다이렉트를 가리켜야 클릭 추적이 된다
      expect(row.link.web).toContain('/r/');
    });

    it('카카오 길이·개수 제한을 지킨다', async () => {
      const card = await recommendUntilCard(app, '도쿄 호텔 추천해줘');

      expect(card.header.title.length).toBeLessThanOrEqual(t.MAX_LIST_HEADER_TITLE);
      expect(card.items.length).toBeGreaterThanOrEqual(1);
      expect(card.items.length).toBeLessThanOrEqual(t.MAX_LIST_ITEMS);
      expect((card.buttons ?? []).length).toBeLessThanOrEqual(t.MAX_LIST_BUTTONS);

      for (const row of card.items) {
        expect(row.title.length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_TITLE);
        expect(row.description.length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_DESC);
      }
      for (const button of card.buttons ?? []) {
        expect(button.label.length).toBeLessThanOrEqual(t.MAX_BUTTON_LABEL);
      }
    });

    it('호텔마다 clickId 가 달라야 어떤 줄을 눌렀는지 구분된다', async () => {
      const card = await recommendUntilCard(app, '오사카 호텔');
      const ids = card.items.map((i: any) => i.link.web.split('/r/')[1]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('엔티티 파라미터가 발화보다 우선한다', async () => {
      const card = await recommendUntilCard(app, '호텔 추천해줘', { city: '후쿠오카' });
      expect(card.header.title).toContain('후쿠오카');
    });
  });

  // ---------------------------------------------------------- 되묻기
  it('도시가 없으면 되묻는다', async () => {
    const res = await post(kakaoPayload('호텔 추천해줘')).expect(201);
    expect(textOf(res.body)).toContain('어느 도시');
    expect(res.body.template.quickReplies).toHaveLength(3);
  });

  it('모르는 도시도 그대로 검색한다 — 화이트리스트가 없다', async () => {
    const card = await recommendUntilCard(app, '파리 호텔 추천해줘');
    expect(card.header.title).toContain('파리');
    expect(provider.calls.map((c) => c.cityName)).toContain('파리');
  });

  it('버튼은 "더 보기" 하나뿐이다 — 도시 전환은 quickReplies 가 한다', async () => {
    // 예전 '다른 도시 보기' 는 도시 없는 문장을 보내 되묻기만 나왔다.
    // 호텔이 안 나오는 버튼이 두 칸뿐인 자리를 먹고 있었다.
    const card = await recommendUntilCard(app, '오사카 호텔');
    expect(card.buttons.map((b: any) => b.label)).toEqual(['더 보기']);

    const quick = (await post(kakaoPayload('오사카 호텔')).expect(201)).body.template
      .quickReplies;
    expect(quick.map((q: any) => q.label)).toContain('도쿄 호텔');
  });

  // ------------------------------------------------------------ 더 보기
  describe('"더 보기" — listCard 5줄 뒤가 있다', () => {
    it('다음 페이지가 있으면 버튼을 달고, 누르면 다음 5곳이 나온다', async () => {
      const first = await recommendUntilCard(app, '오사카 호텔 추천해줘');
      expect(first.items).toHaveLength(5);

      const more = first.buttons.find((b: any) => b.label === '더 보기');
      expect(more.extra).toEqual({ city: '오사카', offset: 5 });
      expect(more.blockId).toBeTruthy();

      // 카카오는 extra 를 action.clientExtra 로 돌려준다.
      const payload = kakaoPayload(more.messageText) as any;
      payload.action.clientExtra = more.extra;
      const second = await post(payload).expect(201);
      const card = listCardOf(second.body);

      expect(card.header.title).toContain('6~');
      // 1페이지에 나온 곳이 2페이지에 또 나오면 안 된다.
      const firstNames = first.items.map((i: any) => i.title);
      for (const row of card.items) expect(firstNames).not.toContain(row.title);
    });

    it('마지막 페이지에는 "더 보기" 가 없다 — 눌러도 같은 게 나오면 고장으로 보인다', async () => {
      const payload = kakaoPayload('오사카 호텔 추천해줘') as any;
      payload.action.clientExtra = { city: '오사카', offset: 5 };
      await recommendUntilCard(app, '오사카 호텔 추천해줘');

      const res = await post(payload).expect(201);
      // 마지막 페이지에는 버튼이 아예 없다 — 달 게 '더 보기' 뿐이었다.
      expect(listCardOf(res.body).buttons).toBeUndefined();
    });

    it('발화만으로도 넘어간다 — 그룹챗방에서 action:block 이 안 될 때의 우회', async () => {
      await recommendUntilCard(app, '오사카 호텔 추천해줘');

      const res = await post(kakaoPayload('오사카 호텔 더 보기')).expect(201);
      expect(listCardOf(res.body).header.title).toContain('6~');
    });

    it('도시가 없는 "호텔 더 보기" 는 되묻는다', async () => {
      const res = await post(kakaoPayload('호텔 더 보기')).expect(201);
      expect(textOf(res.body)).toContain('어느 도시');
    });
  });

  // ---------------------------------------------------------- 리다이렉트
  it('클릭하면 302 로 제휴 주소에 보낸다', async () => {
    const card = await recommendUntilCard(app, '오사카 호텔 추천해줘');
    const clickId = card.items[0].link.web.split('/r/')[1];

    const redirected = await request(app.getHttpServer()).get(`/r/${clickId}`).expect(302);
    const location = redirected.headers.location;
    // 사용자에게는 제휴 주소만 노출된다. 원본 호텔 주소가 그대로 나가면 안 된다.
    expect(location).toMatch(/^https:\/\/adpick\.test\/click\/AB12/);
    // 원본 주소는 제휴 링크 안에 인코딩되어 실린다
    expect(location).toContain('example.com%2Fagoda%2Fhotel');
  });

  it('같은 줄을 여러 번 눌러도 행이 아니라 카운터만 올라간다', async () => {
    const card = await recommendUntilCard(app, '오사카 호텔 추천해줘');
    const clickId = card.items[0].link.web.split('/r/')[1];

    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer()).get(`/r/${clickId}`).expect(302);
    }
    expect(memory.get(clickId)?.clickCount).toBe(3);
  });

  it('없는 clickId 는 404', async () => {
    await request(app.getHttpServer()).get('/r/nope').expect(404);
  });

  it('폴백 블록', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/kakao/fallback')
      .send(kakaoPayload('안녕'))
      .expect(201);
    expect(res.body.template.quickReplies.length).toBeGreaterThan(0);
  });
});

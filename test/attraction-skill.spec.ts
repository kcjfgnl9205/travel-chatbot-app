import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AttractionService } from '../src/modules/attraction/attraction.service';
import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import { NluService } from '../src/modules/nlu/nlu.service';
import { SearchCacheService } from '../src/modules/search-cache/search-cache.service';
import * as t from '../src/modules/kakao/templates';
import { FakeAttractionProvider } from './fake-attraction-provider';
import {
  ATTRACTIONS,
  attractionsUntilCard,
  callbackReceiver,
  createApp,
  kakaoPayload,
  listCardOf,
} from './helpers';

describe('카카오 관광지 스킬', () => {
  let app: INestApplication;
  let provider: FakeAttractionProvider;
  let memory: MemoryStoreService;
  let cache: SearchCacheService;
  let attractions: AttractionService;
  let nlu: NluService;

  beforeAll(async () => {
    ({ app, attractionProvider: provider } = await createApp());
    memory = app.get(MemoryStoreService);
    cache = app.get(SearchCacheService);
    attractions = app.get(AttractionService);
    nlu = app.get(NluService);
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    memory.clear();
    cache.clearMemory();
    attractions.forgetEmpty();
    nlu.clearCache();
    provider.reset();
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(ATTRACTIONS).send(body);

  const textOf = (body: any) => body.template?.outputs?.[0]?.simpleText?.text ?? '';

  // ------------------------------------------------------------ 5초 예산
  describe('캐시 미스는 요청 경로에서 검색하지 않는다', () => {
    it('콜백이 없으면 "찾고 있어요" 로 넘기고 백그라운드에서 검색한다', async () => {
      const res = await post(kakaoPayload('오사카 관광지 추천해줘')).expect(201);

      expect(listCardOf(res.body)).toBeUndefined();
      expect(textOf(res.body)).toContain('찾고 있어요');

      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      expect(card.header.title).toContain('오사카');
    });

    it('응답이 5초 예산 안에 떨어진다 — provider 가 아무리 느려도', async () => {
      provider.delayMs = 3000; // AI 검색이 느린 상황

      const started = Date.now();
      const res = await post(kakaoPayload('방콕 관광지 추천해줘')).expect(201);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(textOf(res.body)).toContain('찾고 있어요');
    });

    it('같은 도시를 동시에 물어도 검색은 한 번만 나간다', async () => {
      provider.delayMs = 200;

      await Promise.all(
        Array.from({ length: 5 }, () => post(kakaoPayload('다낭 관광지 추천해줘'))),
      );
      await attractionsUntilCard(app, '다낭 관광지 추천해줘');

      expect(provider.calls.filter((c) => c.citySlug === 'danang')).toHaveLength(1);
    });

    it('빈손으로 끝난 도시를 연타해도 검색은 한 번만 나간다', async () => {
      provider.reply = () => [];

      for (let i = 0; i < 4; i += 1) {
        await post(kakaoPayload('asdf 관광지 추천해줘')).expect(201);
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(provider.calls.filter((c) => c.citySlug === 'asdf')).toHaveLength(1);
    });

    it('캐시에 있으면 provider 를 아예 안 부른다', async () => {
      await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      const before = provider.calls.length;

      const res = await post(kakaoPayload('오사카 관광지 추천해줘')).expect(201);
      expect(listCardOf(res.body)).toBeDefined();
      expect(provider.calls).toHaveLength(before);
    });
  });

  // ------------------------------------------------------------ 콜백 경로
  it('콜백이 켜져 있으면 useCallback 을 먼저 주고 카드를 POST 한다', async () => {
    const receiver = await callbackReceiver();
    try {
      const res = await post(
        kakaoPayload('오사카 관광지 추천해줘', 'cb-user', {}, receiver.url),
      ).expect(201);

      expect(res.body.useCallback).toBe(true);
      expect(res.body.data.text).toContain('찾고 있어요');

      const card = listCardOf(await receiver.received);
      expect(card.header.title).toContain('오사카 관광지');
      expect(card.items).toHaveLength(t.MAX_LIST_ITEMS);
    } finally {
      await receiver.close();
    }
  });

  // ------------------------------------------------------------ 카드 모양
  describe('listCard — 카카오 제한을 넘기면 말풍선이 통째로 안 보인다', () => {
    it('provider 가 6곳을 줘도 5줄까지만 나간다', async () => {
      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');

      expect(card.header.title.length).toBeLessThanOrEqual(t.MAX_LIST_HEADER_TITLE);
      expect(card.items).toHaveLength(t.MAX_LIST_ITEMS);
      expect((card.buttons ?? []).length).toBeLessThanOrEqual(t.MAX_LIST_BUTTONS);

      for (const row of card.items) {
        expect(row.title.length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_TITLE);
        expect(row.description.length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_DESC);
      }
    });

    it('무료 관광지와 유료 관광지의 문구가 갈린다', async () => {
      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      const descriptions = card.items.map((i: any) => i.description);

      expect(descriptions.some((d: string) => d.startsWith('무료'))).toBe(true);
      // 현지 통화 그대로 나간다. 원화로 환산하면 모델이 틀린 숫자를 만든다.
      expect(descriptions.some((d: string) => d.includes('1,200엔'))).toBe(true);
      expect(descriptions.every((d: string) => !d.includes('원'))).toBe(true);
    });

    it('이미지가 없다 — 관광지는 긁어올 예약 페이지가 없다', async () => {
      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      for (const row of card.items) expect(row.imageUrl).toBeUndefined();
    });

    it('같은 곳이 두 번 오면 하나만 나간다', async () => {
      provider.reply = (query) =>
        ['오사카성', '오사카 성', '도톤보리'].map((name) => ({
          name,
          citySlug: query.citySlug,
          free: true,
          // 이름 표기가 흔들려도 도착지가 같으면 같은 곳이다.
          mapUrl:
            name === '도톤보리'
              ? 'https://www.google.com/maps/search/?api=1&query=b'
              : 'https://www.google.com/maps/search/?api=1&query=a',
        }));

      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      expect(card.items).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------ 지도 링크
  describe('줄 링크 → /r/{clickId} → 구글맵', () => {
    it('카드에는 구글맵이 아니라 우리 리다이렉트가 실린다', async () => {
      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      for (const row of card.items) {
        expect(row.link.web).toMatch(/\/r\/[\w-]{12}$/);
        // 구글맵 주소를 카드에 직접 박으면 누가 뭘 눌렀는지 영영 알 수 없다.
        expect(row.link.web).not.toContain('google.com');
      }
    });

    it('누르면 구글맵으로 302 하고 클릭이 기록된다', async () => {
      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      const clickId = card.items[0].link.web.split('/r/')[1];

      const res = await request(app.getHttpServer()).get(`/r/${clickId}`).expect(302);
      expect(res.headers.location).toContain('google.com/maps/search/');
      // 관광지 이름이 검색어로 들어가 있어야 엉뚱한 곳이 열리지 않는다.
      expect(decodeURIComponent(res.headers.location)).toContain('오사카');

      expect(memory.get(clickId)?.clickCount).toBe(1);
      expect(memory.get(clickId)?.itemName).toContain('오사카');
    });

    it('애드픽을 타지 않는다 — 목적지가 원본 지도 주소 그대로다', async () => {
      const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
      const clickId = card.items[0].link.web.split('/r/')[1];
      const entry = memory.get(clickId);

      expect(entry?.targetUrl).toBe(entry?.sourceUrl);
      expect(entry?.targetUrl).toContain('google.com/maps');
    });
  });

  // ------------------------------------------------------------ 되묻기
  it('도시를 못 알아들으면 되묻는다', async () => {
    const res = await post(kakaoPayload('관광지 추천해줘')).expect(201);
    expect(textOf(res.body)).toContain('어느 도시 관광지');
    expect(provider.calls).toHaveLength(0);
  });

  it('페이로드가 비어도 500 을 내지 않는다', async () => {
    const res = await request(app.getHttpServer()).post(ATTRACTIONS).send({}).expect(201);
    expect(textOf(res.body)).toBeTruthy();
  });

  // ------------------------------------------------------------ 파서 공유
  it('호텔과 같은 파서를 쓴다 — 별칭 캐시가 도메인을 가로질러 재사용된다', async () => {
    // 관광지 스킬이 한 번 파싱하면 그 결과가 NluService 캐시에 남고,
    // 호텔 스킬이 같은 문장을 받으면 모델을 다시 부르지 않는다.
    // (항공권만 노선·날짜 때문에 파서가 따로 있다)
    // 사전에 없는 도시로 본다 — 사전에 있으면 애초에 모델을 안 부르므로
    // 캐시가 공유되는지 안 되는지가 드러나지 않는다.
    expect(nlu.peek('없는도시 관광지 추천해줘').citySlug).toBeNull();

    await post(kakaoPayload('없는도시 관광지 추천해줘')).expect(201);

    expect(nlu.peek('없는도시 관광지 추천해줘').citySlug).toBe('nowhere');
    expect(nlu.peek('없는도시 관광지 추천해줘').cityName).toBe('없는도시');
  });

  it('사전에 있는 도시는 모델 없이 바로 검색된다 — 되묻지 않는다', async () => {
    // 제보된 증상이 이거였다. "세부 여행지 추천해줘" 가 "어느 도시…" 로 떨어졌다.
    const res = await post(kakaoPayload('세부 여행지 추천해줘')).expect(201);
    expect(textOf(res.body)).not.toContain('어느 도시');
  });

  // ------------------------------------------------------------ 퀵리플라이
  it('카드가 나가면 이미 본 도시는 퀵리플라이에서 빼준다', async () => {
    await attractionsUntilCard(app, '오사카 관광지 추천해줘');
    const res = await post(kakaoPayload('오사카 관광지 추천해줘')).expect(201);
    const quick = res.body.template.quickReplies;

    expect(quick.length).toBeLessThanOrEqual(t.MAX_QUICK_REPLIES);
    for (const reply of quick) {
      expect(reply.label.length).toBeLessThanOrEqual(t.MAX_QUICK_REPLY_LABEL);
    }
    expect(quick.map((q: any) => q.label)).not.toContain('오사카 관광지');
  });

  it('"찾고 있어요" 에는 그 도시를 남겨둔다 — 그게 재시도 버튼이다', async () => {
    // 검색은 백그라운드로 돌고 있고, 사용자가 할 일은 "다시 물어보기" 다.
    // 여기서 오사카를 빼면 다시 물을 버튼이 사라진다 (호텔도 같은 이유로 남긴다).
    const res = await post(kakaoPayload('오사카 관광지 추천해줘')).expect(201);
    expect(textOf(res.body)).toContain('찾고 있어요');
    expect(res.body.template.quickReplies.map((q: any) => q.label)).toContain('오사카 관광지');
  });

  it('폴백은 세 도메인을 다 안내하고 퀵리플라이 10개를 넘지 않는다', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/kakao/fallback')
      .send(kakaoPayload('안녕'))
      .expect(201);

    expect(textOf(res.body)).toContain('관광지');
    // 도시 3개 × 3도메인 = 9개. 여기서 하나만 더 늘려도 잘려 나간다.
    expect(res.body.template.quickReplies.length).toBeLessThanOrEqual(t.MAX_QUICK_REPLIES);
  });
});

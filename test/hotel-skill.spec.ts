import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import * as t from '../src/modules/kakao/templates';
import { createApp, kakaoPayload, listCardOf } from './helpers';

const ENDPOINT = '/api/v1/kakao/hotels/recommend';

describe('카카오 호텔 스킬', () => {
  let app: INestApplication;
  let memory: MemoryStoreService;

  beforeAll(async () => {
    app = await createApp();
    memory = app.get(MemoryStoreService);
  });
  afterAll(async () => app.close());
  beforeEach(() => memory.clear());

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(ENDPOINT).send(body);

  it('앱 생존 확인', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('/health 는 환경변수만 본다. 실제 연결 여부는 /health/db 가 판단한다', async () => {
    const res = await request(app.getHttpServer()).get('/health/db').expect(503);
    expect(res.body.status).toBe('disabled');
    expect(res.body.reason).toContain('SUPABASE_URL');
  });

  it('반복 호출해도 깨지지 않는다', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer()).get('/health/db').expect(503);
    }
  });

  it('오사카 → listCard 를 돌려준다', async () => {
    const res = await post(kakaoPayload('오사카 호텔 추천해줘')).expect(201);

    expect(res.body.version).toBe('2.0');
    expect(res.body.template.outputs).toHaveLength(1); // 캐러셀 없이 listCard 하나

    const card = listCardOf(res.body);
    expect(card.header.title).toContain('오사카');
    expect(card.items).toHaveLength(5);

    const row = card.items[0];
    expect(row.title).toBeTruthy();
    expect(row.description).toMatch(/^1박 /);
    expect(row.imageUrl).toMatch(/^https:\/\//);
    // 줄 전체 링크가 애드픽이 아니라 우리 리다이렉트를 가리켜야 클릭 추적이 된다
    expect(row.link.web).toContain('/r/');
  });

  it('카카오 길이·개수 제한을 지킨다', async () => {
    const res = await post(kakaoPayload('도쿄 호텔 추천해줘')).expect(201);
    const card = listCardOf(res.body);

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
    const res = await post(kakaoPayload('오사카 호텔')).expect(201);
    const ids = listCardOf(res.body).items.map((i: any) => i.link.web.split('/r/')[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('엔티티 파라미터가 발화보다 우선한다', async () => {
    const res = await post(kakaoPayload('호텔 추천해줘', 'u', { city: '후쿠오카' })).expect(201);
    expect(listCardOf(res.body).header.title).toContain('후쿠오카');
  });

  it('도시가 없으면 되묻는다', async () => {
    const res = await post(kakaoPayload('호텔 추천해줘')).expect(201);
    expect(res.body.template.outputs[0].simpleText.text).toContain('어느 도시');
    expect(res.body.template.quickReplies).toHaveLength(3);
  });

  it('모르는 도시는 되묻기로 폴백한다', async () => {
    const res = await post(kakaoPayload('파리 호텔 추천해줘')).expect(201);
    expect(res.body.template.outputs[0].simpleText.text).toContain('어느 도시');
  });

  it('카드 버튼의 messageText 가 실제로 되묻기 응답을 만든다', async () => {
    const first = await post(kakaoPayload('오사카 호텔')).expect(201);
    const messageText = listCardOf(first.body).buttons[0].messageText;

    const second = await post(kakaoPayload(messageText)).expect(201);
    expect(second.body.template.outputs[0].simpleText.text).toContain('어느 도시');
  });

  it('클릭하면 302 로 제휴 주소에 보낸다', async () => {
    const res = await post(kakaoPayload('오사카 호텔 추천해줘')).expect(201);
    const clickId = listCardOf(res.body).items[0].link.web.split('/r/')[1];

    const redirected = await request(app.getHttpServer()).get(`/r/${clickId}`).expect(302);
    const location = redirected.headers.location;
    // 사용자에게는 제휴 주소만 노출된다. 원본 호텔 주소가 그대로 나가면 안 된다.
    expect(location).toMatch(/^https:\/\/adpick\.test\/click\/AB12/);
    // 원본 주소는 제휴 링크 안에 인코딩되어 실린다
    expect(location).toContain('example.com%2Fagoda%2Fhotel');
  });

  it('같은 줄을 여러 번 눌러도 행이 아니라 카운터만 올라간다', async () => {
    const res = await post(kakaoPayload('오사카 호텔 추천해줘')).expect(201);
    const clickId = listCardOf(res.body).items[0].link.web.split('/r/')[1];

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

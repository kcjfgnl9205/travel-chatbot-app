import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  ATTRACTION_RESPONSE_EXAMPLE,
  FLIGHT_RESPONSE_EXAMPLE,
  SKILL_RESPONSE_EXAMPLE,
} from '../src/modules/kakao/dto/skill-request.example';
import {
  ATTRACTIONS,
  FLIGHTS,
  RECOMMEND,
  TestApp,
  attractionsUntilCard,
  createApp,
  kakaoPayload,
  recommendUntilCard,
  searchUntilRows,
} from './helpers';

/**
 * 스웨거 예시가 **실제 응답과 같은 모양인가.**
 *
 * 이 예시들은 손으로 적은 상수라 코드가 바뀌어도 저절로 안 따라온다. 실제로
 * 세 번 어긋났다 — 항공권을 listCard 로 바꿨는데 예시는 캐러셀 그대로였고,
 * 관광지에 사진을 붙였는데 예시에는 imageUrl 이 없었고, "더 보기" 를 붙였는데
 * 예시 버튼은 '다른 도시 보기' 하나뿐이었다.
 *
 * 틀린 예시는 없는 예시보다 나쁘다. **읽는 사람이 그걸 믿고 클라이언트를 짠다.**
 * 내용까지 같을 필요는 없으니(도시·가격은 달라도 된다) **구조**만 맞춘다.
 */
describe('스웨거 예시 = 실제 응답', () => {
  let t: TestApp;
  let app: INestApplication;

  beforeAll(async () => {
    t = await createApp();
    app = t.app;
  });
  afterAll(async () => app.close());

  /** 말풍선 종류의 나열. ['listCard'] 인지 ['simpleText','listCard'] 인지. */
  const shapeOf = (body: any): string[] =>
    (body.template?.outputs ?? []).map((o: any) => Object.keys(o)[0]);

  const labelsOf = (card: any): string[] => (card.buttons ?? []).map((b: any) => b.label);

  it('호텔 — 말풍선 구조·버튼·줄 키가 같다', async () => {
    const card = await recommendUntilCard(app, '오사카 호텔 추천해줘');
    const res = await request(app.getHttpServer())
      .post(RECOMMEND)
      .send(kakaoPayload('오사카 호텔 추천해줘'));

    const example = SKILL_RESPONSE_EXAMPLE.template.outputs[0] as any;
    expect(shapeOf(res.body)).toEqual(shapeOf(SKILL_RESPONSE_EXAMPLE));
    expect(labelsOf(example.listCard)).toEqual(labelsOf(card));
    expect(Object.keys(example.listCard.items[0]).sort()).toEqual(
      Object.keys(card.items[0]).sort(),
    );
  });

  it('관광지 — 사진과 출처 버튼이 예시에도 있다', async () => {
    const card = await attractionsUntilCard(app, '오사카 관광지 추천해줘');
    const res = await request(app.getHttpServer())
      .post(ATTRACTIONS)
      .send(kakaoPayload('오사카 관광지 추천해줘'));

    const example = ATTRACTION_RESPONSE_EXAMPLE.template.outputs[0] as any;
    expect(shapeOf(res.body)).toEqual(shapeOf(ATTRACTION_RESPONSE_EXAMPLE));
    expect(labelsOf(example.listCard)).toEqual(labelsOf(card));
    // 사진이 실린 줄의 키가 같아야 한다 (imageUrl 이 빠지면 여기서 걸린다).
    const withImage = card.items.find((i: any) => i.imageUrl);
    expect(Object.keys(example.listCard.items[0]).sort()).toEqual(
      Object.keys(withImage).sort(),
    );
  });

  it('⚠️ 항공권 — 예시가 캐러셀이면 안 된다 (그룹챗방에서 안 보이는 모양이다)', async () => {
    await searchUntilRows(app, '오사카 왕복 항공권 2명');
    const res = await request(app.getHttpServer())
      .post(FLIGHTS)
      .send(kakaoPayload('오사카 왕복 항공권 2명'));

    expect(shapeOf(FLIGHT_RESPONSE_EXAMPLE)).toEqual(['simpleText', 'listCard']);
    expect(shapeOf(res.body)).toEqual(shapeOf(FLIGHT_RESPONSE_EXAMPLE));

    const example = FLIGHT_RESPONSE_EXAMPLE.template.outputs[1] as any;
    const card = res.body.template.outputs[1].listCard;
    expect(labelsOf(example.listCard)).toEqual(labelsOf(card));
    expect(Object.keys(example.listCard.items[0]).sort()).toEqual(
      Object.keys(card.items[0]).sort(),
    );
  });

  it('"더 보기" 예시는 실제로 보내는 모양 그대로다', () => {
    for (const example of [
      SKILL_RESPONSE_EXAMPLE.template.outputs[0],
      ATTRACTION_RESPONSE_EXAMPLE.template.outputs[0],
      FLIGHT_RESPONSE_EXAMPLE.template.outputs[1],
    ] as any[]) {
      const more = example.listCard.buttons.find((b: any) => b.label === '더 보기');
      expect(more.action).toBe('block');
      expect(more.blockId).toMatch(/^[0-9a-f]{24}$/);
      expect(more.extra).toEqual({ city: expect.any(String), offset: 5 });
      expect(more.messageText).toContain('더 보기');
    }
  });
});

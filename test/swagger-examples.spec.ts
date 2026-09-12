import {
  BUSY_EXAMPLE,
  CALLBACK_ACK_EXAMPLE,
  CARD_RESPONSE_EXAMPLE,
  HELP_RESPONSE_EXAMPLE,
  MORE_REQUEST_EXAMPLE,
  ROUTER_REQUEST_EXAMPLE,
  SEARCH_STARTED_EXAMPLE,
} from '../src/modules/kakao/dto/router.example';
import {
  TestApp,
  askUntilCard,
  callbackReceiver,
  createApp,
  kakaoPayload,
  listCardOf,
  post,
} from './helpers';

/**
 * 스웨거 예시가 **실제 응답과 같은 모양인가.**
 *
 * 이 예시들은 손으로 적은 상수라 코드가 바뀌어도 저절로 안 따라온다. 실제로 세 번
 * 어긋났다 — 항공권을 listCard 로 바꿨는데 예시는 캐러셀 그대로였고, 관광지에 사진을
 * 붙였는데 예시에는 imageUrl 이 없었고, "더 보기" 를 붙였는데 예시 버튼은
 * '다른 도시 보기' 하나뿐이었다.
 *
 * 틀린 예시는 없는 예시보다 나쁘다. **읽는 사람이 그걸 믿고 클라이언트를 짠다.**
 * 내용까지 같을 필요는 없으니(도시·가격은 달라도 된다) **구조**만 맞춘다.
 */
describe('스웨거 예시 = 실제 응답', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(() => ctx.reset());

  /** 말풍선 종류의 나열. ['listCard','simpleText'] 처럼. */
  const shapeOf = (body: any): string[] =>
    (body?.template?.outputs ?? []).map((o: any) => Object.keys(o)[0]);

  it('예시 페이로드를 그대로 보내면 동작한다', async () => {
    const res = await post(ctx.app, ROUTER_REQUEST_EXAMPLE);

    expect(res.status).toBe(201);
    expect(res.body.version).toBe('2.0');
  });

  it('카드 — 카드 뒤에 고지 말풍선이 온다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');

    // ⚠️ 순서가 중요하다. 고지가 위에 오면 결과를 가린다.
    expect(shapeOf(CARD_RESPONSE_EXAMPLE)).toEqual(['listCard', 'simpleText']);
    expect(shapeOf(body)).toEqual(shapeOf(CARD_RESPONSE_EXAMPLE));

    const example = (CARD_RESPONSE_EXAMPLE.template.outputs[0] as any).listCard;
    const card = listCardOf(body);
    // 예시에 없는 키가 실제 응답에 있으면 안 된다 (imageUrl 은 있을 때만 붙는 선택 키다).
    const keys = Object.keys(card.items[0]).filter((k) => k !== 'imageUrl');
    expect(keys.sort()).toEqual(Object.keys(example.items[0]).sort());
  });

  it('더보기 예시는 실제로 보내는 모양 그대로다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const actual = listCardOf(body).buttons.find((b: any) => b.label === '더 보기');
    const example = (CARD_RESPONSE_EXAMPLE.template.outputs[0] as any).listCard.buttons[0];

    expect(Object.keys(example).sort()).toEqual(Object.keys(actual).sort());
    expect(Object.keys(example.extra).sort()).toEqual(Object.keys(actual.extra).sort());
    // 버튼이 실어 보내는 것과 서버가 읽는 것이 같은 키여야 한다.
    expect(Object.keys(MORE_REQUEST_EXAMPLE.action.clientExtra).sort()).toEqual(
      Object.keys(actual.extra).sort(),
    );
  });

  it('도움말 — 세 가지를 예시와 함께 보여준다', async () => {
    const res = await post(ctx.app, kakaoPayload('안녕하세요'));

    expect(shapeOf(res.body)).toEqual(shapeOf(HELP_RESPONSE_EXAMPLE));
    expect(listCardOf(res.body).items).toHaveLength(
      (HELP_RESPONSE_EXAMPLE.template.outputs[0] as any).listCard.items.length,
    );
  });

  it('검색중 · 조회중 — simpleText 하나다', async () => {
    ctx.provider.delayMs = 200;
    const first = await post(ctx.app, kakaoPayload('도쿄 호텔 추천해줘'));
    const second = await post(ctx.app, kakaoPayload('도쿄 호텔 추천해줘', { userKey: 'u2' }));

    expect(shapeOf(first.body)).toEqual(shapeOf(SEARCH_STARTED_EXAMPLE));
    expect(shapeOf(second.body)).toEqual(shapeOf(BUSY_EXAMPLE));
  });

  it('콜백 예약 — useCallback 과 data.text 를 그대로 준다', async () => {
    const receiver = await callbackReceiver();
    try {
      const res = await post(
        ctx.app,
        kakaoPayload('후쿠오카 호텔 추천해줘', { callbackUrl: receiver.url }),
      );

      expect(Object.keys(res.body).sort()).toEqual(Object.keys(CALLBACK_ACK_EXAMPLE).sort());
      expect(Object.keys(res.body.data)).toEqual(Object.keys(CALLBACK_ACK_EXAMPLE.data));
      await receiver.received;
    } finally {
      await receiver.close();
    }
  });
});

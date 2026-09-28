import { TestApp, createApp, kakaoPayload, post } from './helpers';

/**
 * 관광지는 **한 번에 답한다.**
 *
 * 0008 까지는 구글 6회 + 모델 2회 + 사진 N회라 7~30초가 걸렸고, 첫 질문에는
 * "찾고 있어요" 를 보낸 뒤 콜백으로 카드를 밀어야 했다. 0009 에서 목록이 우리 DB 로
 * 오면서 쿼리 하나가 됐고, 그래서 요청 경로에서 그대로 돈다.
 *
 * ⚠️ **콜백 의존이 사라지는 게 진짜 이득이다.** 단톡방에서 콜백 푸시가 실제로 오는지
 *    검증되지 않았다 — 안 오면 사용자는 영원히 답을 못 받는다. 이 경로에는 그 구멍이
 *    없으므로, 그 사실을 테스트로 고정한다.
 */
describe('관광지 즉시 응답', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(() => ctx.reset());

  /** 카드가 왔는지. "찾고 있어요" 는 simpleText 한 장이라 listCard 가 없다. */
  function cardOf(body: any) {
    return (body.template?.outputs ?? []).find((o: any) => o.listCard)?.listCard;
  }

  it('첫 질문에 바로 카드가 온다 — 대기 말풍선이 없다', async () => {
    const res = await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);

    const card = cardOf(res.body);
    expect(card).toBeDefined();
    expect(card.header.title).toContain('오사카 관광지');
    expect(card.items.length).toBeGreaterThan(0);

    // ⚠️ 대기 응답이면 여기에 '찾고 있어요' 만 있고 카드가 없다.
    expect(JSON.stringify(res.body)).not.toContain('찾고 있어요');
  });

  it('콜백이 켜져 있어도 대기 응답을 쓰지 않는다', async () => {
    const res = await post(
      ctx.app,
      kakaoPayload('오사카 관광지 추천해줘', { callbackUrl: 'https://callback.test/x' }),
    ).expect(201);

    expect(cardOf(res.body)).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('찾고 있어요');
  });

  /**
   * 캐시를 안 읽으므로 **물을 때마다 provider 를 부른다.**
   *
   * 낭비처럼 보이지만 이게 의도다 — 관리 화면에서 방금 고친 것이 다음 질문에 바로
   * 보여야 한다. 아끼는 대상이 AI 호출이 아니라 인덱스 하나 타는 쿼리라 무게가 다르다.
   */
  it('물을 때마다 다시 읽는다 — 관리 화면 수정이 곧바로 반영된다', async () => {
    await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);
    await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);

    expect(ctx.attractionProvider.calls.length).toBe(2);
  });

  it('도시 id 로 조회한다 — 이름이 아니라', async () => {
    await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);

    const [query] = ctx.attractionProvider.calls;
    expect(typeof query.cityId).toBe('number');
    expect(query.cityName).toContain('오사카');
  });

  /**
   * 빈 도시는 **느린 경로로 넘어간다** — 모델이 채워야 하고 그건 몇 초짜리다.
   *
   * `peek` 이 null 을 주면 SearchService 가 선점하고 "찾고 있어요" 를 보낸다.
   * 관광지에서 이 문구가 나오는 유일한 경우다.
   */
  it('등록된 곳이 없으면 느린 경로로 넘어간다 — 모델이 채운다', async () => {
    ctx.attractionProvider.reply = () => [];

    const res = await post(
      ctx.app,
      kakaoPayload('오사카 관광지 추천해줘', { callbackUrl: 'https://callback.test/x' }),
    ).expect(201);

    expect(cardOf(res.body)).toBeUndefined();
    expect(JSON.stringify(res.body)).toContain('찾고 있어요');
  });

  /**
   * ⚠️ **실패 행을 남기지 않는다.** 느린 경로는 AI 를 다시 부르지 않으려고 failed 를
   *    꽂아두는데, 여기는 재시도가 쿼리 한 번이라 막을 이유가 없다. 막으면 DB 가
   *    1초 흔들린 대가로 그 도시가 TTL 동안 빈다.
   */
  it('한 번 실패해도 다음 질문에 다시 시도한다', async () => {
    ctx.attractionProvider.reply = () => {
      throw new Error('DB 흔들림');
    };
    await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);

    ctx.attractionProvider.reset();
    const res = await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);

    expect(cardOf(res.body)).toBeDefined();
  });

  /** 사진을 안 넣은 곳이 섞여도 그 줄만 사진 없이 나간다. 목록에서 빼지 않는다. */
  it('사진 없는 줄이 섞여도 목록에 남는다', async () => {
    const res = await post(ctx.app, kakaoPayload('오사카 관광지 추천해줘')).expect(201);

    const items = cardOf(res.body).items;
    expect(items.some((i: any) => !i.imageUrl)).toBe(true);
    expect(items.some((i: any) => i.imageUrl)).toBe(true);
  });
});

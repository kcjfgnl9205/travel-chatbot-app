// ⚠️ 앱을 만들기 전에 정해야 한다. 설정은 부팅 때 한 번 읽는다.
process.env.MORE_BUTTON_STYLE = 'message';

import {
  TestApp,
  askUntilCard,
  createApp,
  kakaoPayload,
  listCardOf,
  moreButtonOf,
  post,
} from './helpers';

/**
 * `action: "block"` 이 그룹챗방에서 안 될 때의 우회로.
 *
 * itemCard 가 그랬던 것처럼 block 버튼도 안 그려질 수 있다. 그때는 평범한 메시지
 * 버튼으로 내리는데, 메시지는 **커서를 실을 수 없다** — 발화("오사카 호텔 더 보기")가
 * 전부다. 그래서 서버가 발화자별로 "다음은 6번째부터" 를 잠깐 기억한다.
 */
describe('더보기 — 메시지 버튼 경로', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    delete process.env.MORE_BUTTON_STYLE;
  });
  beforeEach(() => ctx.reset());

  it('버튼이 block 이 아니라 message 다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const button = moreButtonOf(body);

    expect(button).toMatchObject({ action: 'message', messageText: '오사카 호텔 더 보기' });
    expect(button.extra).toBeUndefined();
  });

  it('발화만 와도 다음 페이지가 나온다 (발화자별 커서)', async () => {
    await askUntilCard(ctx.app, '오사카 호텔 추천해줘');

    const next = await post(ctx.app, kakaoPayload('오사카 호텔 더 보기'));

    expect(listCardOf(next.body).header.title).toContain('6~10번째');
    // 저장된 행에서 잘라 보냈을 뿐이다 — AI 는 처음 한 번만 돌았다.
    expect(ctx.provider.calls).toHaveLength(1);
  });

  it('커서는 사람마다 따로다 — 단톡방에서 남의 페이지로 넘어가면 안 된다', async () => {
    await askUntilCard(ctx.app, '오사카 호텔 추천해줘', { userKey: 'a' });

    const stranger = await post(
      ctx.app,
      kakaoPayload('오사카 호텔 더 보기', { userKey: 'b' }),
    );

    // 커서가 없는 사람에게는 첫 페이지를 준다 (발화에 지역이 들어 있다).
    expect(listCardOf(stranger.body).header.title).toBe('오사카 호텔 5곳');
  });
});

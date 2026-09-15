import {
  TestApp,
  askUntilCard,
  callbackReceiver,
  createApp,
  kakaoPayload,
  listCardOf,
  moreButtonOf,
  noticeOf,
  post,
  textOf,
} from './helpers';

/**
 * 라우터 통합 테스트.
 *
 * 오픈빌더에 블록이 하나도 없으므로 **모든 발화가 이 엔드포인트 하나로 온다.**
 * 그래서 여기서 깨지는 건 곧 단톡방에서 깨지는 것이다.
 */
describe('POST /api/v1/kakao/router', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(() => {
    ctx.reset();
  });

  // ------------------------------------------------------------ 1차 필터
  it('여행과 무관한 잡담에는 도움말 카드를 주고 AI 를 아예 부르지 않는다', async () => {
    const res = await post(ctx.app, kakaoPayload('@여행메이트 안녕 다들 뭐해?'));

    expect(res.status).toBe(201);
    const card = listCardOf(res.body);
    expect(card.header.title).toContain('여행메이트');
    expect(card.items).toHaveLength(3);
    // ⚠️ 오류 문구를 쓰지 않는다. 인사말까지 오류로 취급하면 단톡방이 딱딱해진다.
    expect(JSON.stringify(res.body)).not.toMatch(/잘못|오류|실패/);
    // 1차 필터가 잡아냈으므로 모델도 provider 도 안 돌았다 = 요금 0원.
    expect(ctx.openai.calls).toHaveLength(0);
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('여행 신호는 있는데 지역이 없으면 되묻는다', async () => {
    const res = await post(ctx.app, kakaoPayload('호텔 추천해줘'));

    expect(textOf(res.body)).toContain('어느 지역');
    expect(res.body.template.quickReplies.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------ 호텔 흐름
  it('사전에 있는 도시는 모델 없이 해석하고, 검색이 끝나면 카드가 나온다', async () => {
    const first = await post(ctx.app, kakaoPayload('오사카 호텔 추천해줘'));
    // 5초 예산 안에서는 검색을 끝낼 수 없다. 먼저 "찾고 있어요" 가 나간다.
    expect(textOf(first.body)).toContain('찾고 있어요');

    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const card = listCardOf(body);

    expect(card.header.title).toBe('오사카 호텔 5곳');
    expect(card.items).toHaveLength(5);
    expect(card.items[0].link.web).toMatch(/\/r\/[A-Za-z0-9_-]+$/);
    // 키워드 + 도시 사전으로 끝났다 — 발화 해석에 모델을 쓰지 않았다.
    expect(ctx.openai.calls).toHaveLength(0);
    expect(ctx.provider.calls).toHaveLength(1);
  });

  it('무시한 조건이 있으면 이름과 함께 알려준다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 4명 9월 22일 추천해줘');
    const notice = noticeOf(body);

    // ⚠️ 이 고지가 이 설계의 전제 조건이다. 날짜를 반영하지 않은 결과를 말없이 주면
    //    사용자는 속았다고 느낀다.
    expect(notice).toContain('반영되지 않았어요');
    expect(notice).toContain('4명');
    expect(notice).toMatch(/날짜|인원/);
  });

  it('할 말이 없으면 고지 말풍선을 아예 안 붙인다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');

    // 매 카드마다 같은 문장을 반복하지 않는다 — 말풍선이 두 개씩 쌓인다.
    expect(body.template.outputs).toHaveLength(1);
    expect(noticeOf(body)).toBe('');
  });

  it('같은 지역을 다시 물으면 저장된 결과가 나간다 — AI 는 한 번만 돈다', async () => {
    await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    expect(ctx.provider.calls).toHaveLength(1);

    const again = await post(ctx.app, kakaoPayload('오사카 숙소 알려줘', { userKey: 'other' }));

    expect(listCardOf(again.body).items).toHaveLength(5);
    expect(ctx.provider.calls).toHaveLength(1);
  });

  it('세 명이 동시에 같은 걸 물어도 검색은 한 번만 돈다 (pending 선점)', async () => {
    ctx.provider.delayMs = 60;

    const bodies = ['오사카 호텔 추천해줘', '오사카 호텔 추천', '오사카 숙소'];
    await Promise.all(
      bodies.map((u, i) => post(ctx.app, kakaoPayload(u, { userKey: `u${i}` }))),
    );

    expect(ctx.provider.calls).toHaveLength(1);
  });

  it('먼저 찾고 있는 중이면 그렇게 알려준다', async () => {
    ctx.provider.delayMs = 200;
    await post(ctx.app, kakaoPayload('도쿄 호텔 추천해줘'));

    const second = await post(ctx.app, kakaoPayload('도쿄 호텔 추천해줘', { userKey: 'u2' }));

    expect(textOf(second.body)).toContain('먼저 찾고 있어요');
    expect(ctx.provider.calls).toHaveLength(1);
  });

  // ---------------------------------------------------------- 더 보기
  it('더보기 버튼은 커서를 들고 다닌다 — 서버는 누가 어디까지 봤는지 모른다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const button = moreButtonOf(body);

    expect(button).toMatchObject({
      action: 'block',
      blockId: 'fallback-block',
      extra: { offset: 5 },
    });
    expect(String(button.extra.cache_key)).toMatch(/^hotel:\d+$/);
  });

  it('더보기는 저장된 행에서 잘라 보낸다 — AI 호출 0회', async () => {
    const first = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const cursor = moreButtonOf(first).extra;
    const searchCalls = ctx.provider.calls.length;

    const second = await post(ctx.app, kakaoPayload('오사카 호텔 더 보기', { clientExtra: cursor }));
    const card = listCardOf(second.body);

    expect(card.header.title).toContain('6~10번째');
    expect(card.items).toHaveLength(5);
    expect(card.items[0].title).not.toBe(listCardOf(first).items[0].title);
    expect(ctx.provider.calls).toHaveLength(searchCalls);
  });

  it('마지막 페이지에는 더보기 버튼을 달지 않는다', async () => {
    const first = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const cacheKey = moreButtonOf(first).extra.cache_key;

    const last = await post(
      ctx.app,
      kakaoPayload('오사카 호텔 더 보기', { clientExtra: { cache_key: cacheKey, offset: 10 } }),
    );

    // provider 가 12곳을 주므로 11~12번째가 마지막이다.
    expect(listCardOf(last.body).items).toHaveLength(2);
    expect(moreButtonOf(last.body)).toBeUndefined();
  });

  // ---------------------------------------------------------- 항공권
  it('항공권도 listCard 다 — 그룹챗봇은 itemCard 를 못 그린다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 항공권 찾아줘');

    expect(JSON.stringify(body)).not.toContain('carousel');
    expect(JSON.stringify(body)).not.toContain('itemCard');
    expect(listCardOf(body).header.title).toContain('항공권');
  });

  it('출발지를 말하지 않으면 서울 출발로 보고 그 사실을 적는다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 항공권 찾아줘');

    expect(noticeOf(body)).toContain('서울 출발 기준');
    expect(ctx.flightProvider.calls[0]).toMatchObject({
      originName: '서울',
      destName: '오사카',
      tripType: 'round',
    });
  });

  it('편도는 왕복과 다른 캐시를 쓴다', async () => {
    await askUntilCard(ctx.app, '오사카 편도 항공권 찾아줘');
    expect(ctx.flightProvider.calls[0].tripType).toBe('oneway');

    await askUntilCard(ctx.app, '오사카 항공권 찾아줘');
    expect(ctx.flightProvider.calls).toHaveLength(2);
    expect(ctx.flightProvider.calls[1].tripType).toBe('round');
  });

  // ---------------------------------------------------------- 관광지
  it('관광지는 지도 링크로 간다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 관광지 추천해줘');

    expect(listCardOf(body).header.title).toContain('관광지');
    expect(ctx.attractionProvider.calls).toHaveLength(1);
  });

  it('사전에 없는 세부 지역은 모델에게 물어 등록하고, 부모 도시를 붙여 검색한다', async () => {
    await askUntilCard(ctx.app, '도톤보리 맛집 알려줘');

    expect(ctx.attractionProvider.calls[0]).toMatchObject({
      citySlug: 'dotonbori',
      // 세부 지역만 주면 모델이 어디인지 모른다. 부모 도시를 붙여야 검색이 된다.
      cityName: '도톤보리 오사카',
    });
  });

  // ---------------------------------------------------------- 나라
  it('나라를 말하면 그 나라의 도시로 되묻는다', async () => {
    const res = await post(ctx.app, kakaoPayload('베트남 여행지 추천해줘'));

    // ⚠️ 카드로 보여준다. 단톡방에서는 봇을 멘션한 메시지만 서버로 오므로,
    //    사용자가 도시 이름을 직접 치면 멘션이 빠져 봇이 아예 못 듣는다 — 눌러야 한다.
    const card = listCardOf(res.body);
    expect(card.header.title).toBe('베트남 어디로 가세요?');
    expect(card.items[0]).toMatchObject({ action: 'message' });
    expect(String(card.items[0].messageText)).toContain('관광지');
    const labels = res.body.template.quickReplies.map((q: any) => q.label);
    // ⚠️ 예전에는 베트남을 물어도 오사카·도쿄·후쿠오카를 권했다. 딴소리였다.
    expect(labels).toEqual(
      expect.arrayContaining(['다낭 관광지', '하노이 관광지', '호치민 관광지']),
    );
    expect(labels.join()).not.toContain('오사카');
    // 검색은 돌지 않는다 — 나라 단위 결과는 도시가 섞여 쓸모가 없다.
    expect(ctx.attractionProvider.calls).toHaveLength(0);
  });

  it('되묻기 버튼을 누르면 그대로 그 도시 검색이 된다', async () => {
    await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));
    const res = await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));
    const first = res.body.template.quickReplies[0];

    const body = await askUntilCard(ctx.app, String(first.messageText));

    expect(listCardOf(body).header.title).toContain('다낭');
  });

  it('도시 목록은 나라당 한 번만 묻는다', async () => {
    const cityLookups = () =>
      ctx.openai.calls.filter(
        (c) => (c.format as { name?: string } | undefined)?.name === 'country_cities',
      ).length;

    await post(ctx.app, kakaoPayload('베트남 여행지 추천해줘'));
    expect(cityLookups()).toBe(1);

    await post(ctx.app, kakaoPayload('베트남 관광지 알려줘'));

    // ⚠️ 첫 질문이 5초 예산을 넘기면 사용자는 아무것도 못 받는다. 실측으로 25초가 걸린 적 있다 —
    //    그때는 도시 6곳을 요청 경로에서 하나씩 등록하고 있었다. 지금은 이름만 쓰고 등록은 뒤로 미룬다.
    expect(cityLookups()).toBe(1);
  });

  it('사전에 있는 나라는 의도도 지역도 모델 없이 판정한다', async () => {
    const res = await post(ctx.app, kakaoPayload('일본 호텔 추천해줘'));

    expect(listCardOf(res.body).header.title).toBe('일본 어디로 가세요?');
    // ⚠️ 모델에 맡겼더니 같은 "독일" 을 어떤 때는 나라로, 어떤 때는 도시로 봤다.
    //    그때마다 나라가 지역 하나로 검색돼 뭉개진 결과가 나갔다. 사전이 그 흔들림을 없앤다.
    const parsing = ctx.openai.calls.filter((c) =>
      ['parsed_intent', 'place_lookup'].includes(
        (c.format as { name?: string } | undefined)?.name ?? '',
      ),
    );
    expect(parsing).toHaveLength(0);
  });

  it('나라 안에 도시가 있으면 도시가 이긴다 — "일본 오사카 호텔" 은 되묻지 않는다', async () => {
    const body = await askUntilCard(ctx.app, '일본 오사카 호텔 추천해줘');

    expect(listCardOf(body).header.title).toContain('오사카');
  });

  it('도시 카드 아래에 "다른 도시" 안내 영역이 따로 선다', async () => {
    const res = await post(ctx.app, kakaoPayload('베트남 여행지 추천해줘'));
    const outputs = res.body.template.outputs;

    // 고르라고 늘어놓는 선택지가 많으면 고르는 게 아니라 훑는 게 된다.
    expect(listCardOf(res.body).items.length).toBeLessThanOrEqual(5);

    // ⚠️ 카드 안 버튼이 아니라 **따로 세운다.** 5줄과 나란히 두면 여섯 번째 선택지처럼
    //    보이는데, 이건 선택지가 아니라 다른 길이다.
    const guide = outputs.find((o: any) => o.textCard)?.textCard;
    expect(guide.title).toContain('다른 도시');
    expect(guide.buttons[0]).toMatchObject({ action: 'message' });
    // ⚠️ 카카오는 입력창을 미리 채우지 못한다. 멘션을 포함한 예문이 최선이다.
    expect(guide.description).toContain('@여행메이트');
  });

  it('"다른 도시" 를 누르면 도시 이름만 받아서 이어 검색한다', async () => {
    // ⚠️ 카카오에는 입력창을 미리 채우는 버튼이 없다. 그래서 한 번 되묻고 다음 발화를 받는다.
    const asked = await post(ctx.app, kakaoPayload('호텔 다른 도시'));
    // ⚠️ 멘션을 빼먹으면 봇이 못 듣는다. 안내에 그 방법이 들어가야 한다.
    expect(textOf(asked.body)).toMatch(/도시 이름을 보내주세요|멘션/);

    // 사용자가 도시 이름만 보낸다. "다낭" 에는 여행 신호가 없어서 원래는 도움말로 떨어진다.
    const body = await askUntilCard(ctx.app, '다낭');

    expect(listCardOf(body).header.title).toContain('다낭');
  });

  it('되묻기는 사람마다 따로다 — 남의 대답을 가로채지 않는다', async () => {
    await post(ctx.app, kakaoPayload('호텔 다른 도시', { userKey: 'a' }));

    const stranger = await post(ctx.app, kakaoPayload('다낭', { userKey: 'b' }));

    // B 는 되묻기를 받은 적이 없다. 그냥 도움말이 나가야 한다.
    expect(listCardOf(stranger.body)?.header?.title).toContain('여행메이트');
  });

  it('되묻기 상태여도 지명 같지 않은 말은 받지 않는다', async () => {
    await post(ctx.app, kakaoPayload('관광지 다른 도시'));

    const res = await post(ctx.app, kakaoPayload('ㅋㅋㅋ 거기 어디였지?'));

    // 아무 말이나 지명으로 등록하면 places 가 쓰레기로 찬다.
    expect(listCardOf(res.body)?.header?.title).toContain('여행메이트');
  });

  // ---------------------------------------------------------- 실패 경로
  it('결과가 비어도 "도시 이름을 확인하라" 고 하지 않는다', async () => {
    ctx.provider.reply = () => [];

    const res = await post(ctx.app, kakaoPayload('후쿠오카 호텔 추천해줘'));
    await new Promise((r) => setTimeout(r, 60));
    const again = await post(ctx.app, kakaoPayload('후쿠오카 호텔 추천해줘'));

    const text = textOf(again.body) || textOf(res.body);
    // 지역은 제대로 알아들었다. 사용자가 자기 잘못인 줄 알게 만들면 안 된다.
    expect(text).not.toContain('도시 이름');
    expect(text).toMatch(/못했어요|찾고 있어요/);
  });

  it('검색이 터져도 500 을 내지 않는다', async () => {
    ctx.provider.reply = () => {
      throw new Error('provider 폭발');
    };

    const res = await post(ctx.app, kakaoPayload('도쿄 호텔 추천해줘'));

    expect(res.status).toBe(201);
    expect(res.body.version).toBe('2.0');
  });

  it('검색을 할 수 없는 상태면 기다리라고 하지 않는다', async () => {
    // OPENAI_API_KEY 가 빠진 서버. provider 가 스스로 "지금은 못 한다" 고 말한다.
    (ctx.provider as { enabled?: boolean }).enabled = false;
    try {
      const res = await post(ctx.app, kakaoPayload('오사카 호텔 추천해줘'));

      // ⚠️ "30초쯤 뒤에 다시 물어봐 주세요" 는 결과가 영원히 안 오는데 기다리게 하는 말이다.
      expect(textOf(res.body)).not.toContain('30초');
      expect(textOf(res.body)).toContain('안 되고 있어요');
      // 검색을 시도하지도, 실패 행을 남기지도 않는다 — 키를 꽂으면 바로 살아나야 한다.
      expect(ctx.provider.calls).toHaveLength(0);
    } finally {
      delete (ctx.provider as { enabled?: boolean }).enabled;
    }
  });

  it('키를 꽂으면 바로 살아난다 — 실패를 굳혀두지 않았다', async () => {
    (ctx.provider as { enabled?: boolean }).enabled = false;
    await post(ctx.app, kakaoPayload('후쿠오카 호텔 추천해줘'));
    delete (ctx.provider as { enabled?: boolean }).enabled;

    const body = await askUntilCard(ctx.app, '후쿠오카 호텔 추천해줘');

    expect(listCardOf(body).items).toHaveLength(5);
  });

  // ---------------------------------------------------------- 콜백
  it('콜백이 켜져 있으면 대기 응답을 주고 결과를 밀어준다', async () => {
    const receiver = await callbackReceiver();
    try {
      const res = await post(
        ctx.app,
        kakaoPayload('후쿠오카 호텔 추천해줘', { callbackUrl: receiver.url }),
      );

      expect(res.body.useCallback).toBe(true);
      expect(String(res.body.data.text)).toContain('찾고 있어요');

      const pushed = await receiver.received;
      expect(listCardOf(pushed).items).toHaveLength(5);
    } finally {
      await receiver.close();
    }
  });
});

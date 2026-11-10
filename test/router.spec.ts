import { AppConfig, CONFIG } from '../src/config/app.config';
import {
  TestApp,
  askUntilCard,
  callbackReceiver,
  createApp,
  kakaoPayload,
  listCardOf,
  mentionCardOf,
  notUnderstoodCardOf,
  moreButtonOf,
  shareButtonOf,
  noticeOf,
  post,
  textOf,
} from './helpers';
import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import { OpenAiHttpError } from '../src/modules/openai/openai.service';

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
  it('여행과 무관한 잡담에는 안내 카드를 주고 AI 를 아예 부르지 않는다', async () => {
    const res = await post(ctx.app, kakaoPayload('@가자고 안녕 다들 뭐해?'));

    expect(res.status).toBe(201);
    const card = notUnderstoodCardOf(res.body);
    expect(card.title).toBe('🤔 어떤 여행을 찾으시나요?');
    // 예시는 챗봇 설정의 도움말이 가진다 — 카드에는 그걸 여는 버튼 하나뿐이다.
    expect(card.buttons).toEqual([{ label: '도움말', action: 'guide' }]);
    // ⚠️ 오류 문구를 쓰지 않는다. 인사말까지 오류로 취급하면 단톡방이 딱딱해진다.
    expect(JSON.stringify(res.body)).not.toMatch(/잘못|오류|실패/);
    // 1차 필터가 잡아냈으므로 모델도 provider 도 안 돌았다 = 요금 0원.
    expect(ctx.openai.calls).toHaveLength(0);
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('여행 신호는 있는데 지역이 없으면 되묻는다', async () => {
    const res = await post(ctx.app, kakaoPayload('호텔 추천해줘'));

    expect(textOf(res.body)).toContain('어느 지역');
    // ⚠️ **누를 것이 같이 나가야 한다.** 되묻는 말만 있고 누를 게 없으면 거기서
    //    대화가 끊긴다 — 단톡방에서는 멘션 없는 답장이 봇에게 오지 않기 때문이다.
    expect(mentionCardOf(res.body)).toBeDefined();
  });

  /**
   * ⚠️ **팀채팅 챗봇은 QuickReplies 를 지원하지 않는다** (그룹 챗봇 beta 가이드 표 3).
   *    한동안 모든 응답에 달아뒀는데 단톡방에서는 아무것도 안 보였다. 되살아나면
   *    안 보이는 기능을 다시 믿게 되므로 여기서 막는다.
   */
  it('퀵리플라이를 쓰지 않는다 — 팀채팅에서 보이지 않는다', async () => {
    for (const utterance of ['안녕하세요', '호텔 추천해줘', '오사카 호텔 추천해줘']) {
      const res = await post(ctx.app, kakaoPayload(utterance));
      expect(res.body.template.quickReplies).toBeUndefined();
    }
  });

  it('멘션 버튼은 action 이 mention 이고 라벨이 @봇이름 이다', async () => {
    const res = await post(ctx.app, kakaoPayload('호텔 추천해줘'));
    const card = mentionCardOf(res.body);

    expect(card.description).toBe('가자고 TST에게 이어서 말하기');
    // ⚠️ 문서에 없는 값(talk_mention)을 쓰면 **응답 전체가 렌더링되지 않는다.**
    //    그룹 챗봇 beta 가이드의 봇 응답 버튼 플러그인 표에 있는 이름은 mention 이다.
    expect(card.buttons).toEqual([{ label: '@가자고 TST', action: 'mention' }]);
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

  /**
   * ⚠️ **날짜·인원은 이제 링크에 반영된다**(트립닷컴만 쓰므로 조건이 살아서 간다).
   *    그래서 그 둘은 「반영되지 않았어요」에서 빠지고, 예산·테마처럼 **정말로 반영하지
   *    않는 조건만** 남는다. 반영한 조건을 반영 안 했다고 적으면 맞는 링크를 받고도
   *    틀렸다고 읽는다.
   */
  it('무시한 조건이 있으면 이름과 함께 알려준다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 10만원 이하 4명 9월 22일 추천해줘');
    const notice = noticeOf(body);

    // ⚠️ 이 고지가 이 설계의 전제 조건이다. 반영하지 않은 조건을 말없이 버리면
    //    사용자는 속았다고 느낀다.
    expect(notice).toContain('예산(10만원)은 반영되지 않았어요');
    // 날짜·인원은 링크로 간다 — 버린 조건 목록에 있으면 안 된다.
    expect(notice).not.toContain('4명)');
    expect(notice).toContain('9월 22일 체크인');
    expect(notice).toContain('4명으로 열려요');
  });

  it('테마를 말해도 반영하지 않는다 — 그러면 그렇다고 알린다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 아이랑 갈 만한 관광지 추천해줘');
    const notice = noticeOf(body);

    // ⚠️ 날짜·인원은 알리면서 테마만 침묵하면 **그것만 반영된 줄 안다.**
    //    "아이랑" 을 '인원' 이라고 부르면 사용자가 자기 말과 못 잇는다.
    expect(notice).toContain('테마');
    expect(notice).toContain('아이랑');
    expect(notice).toContain('반영되지 않았어요');
  });

  /**
   * **호텔 날짜도 조용히 고치지 않는다.**
   *
   * ⚠️ 항공권과 하나가 다르다 — 체크인과 체크아웃이 **같은 날이면 0박**이라 검색
   *    자체가 안 된다. 항공권에서 같은 날은 당일치기라 멀쩡한 일정이라서, 판정도
   *    카드도 따로 간다([hotel/search-url.ts](../src/modules/hotel/search-url.ts) stayProblem).
   */
  describe('호텔 날짜가 잘못됐을 때', () => {
    it('체크인과 체크아웃이 같은 날이면 링크 대신 되묻는다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('오사카 호텔 11월 20일 체크인 11월 20일 체크아웃'),
      );

      // 이유는 말풍선에 온전히 싣는다 — 리스트 헤더는 한 줄만 보이고 「…」로 잘린다.
      expect(res.body.template.outputs[0].simpleText.text).toContain('1박 이상');
      expect(listCardOf(res.body).header.title).toBe('날짜를 다시 골라주세요');
      // ⚠️ **링크를 주면 안 된다.** 날짜에 동의하기 전이다.
      expect(JSON.stringify(res.body)).not.toContain('/r/');
      // AI 도 부르지 않는다 — 되물을 일에 7~30초짜리 검색을 태울 이유가 없다.
      expect(ctx.provider.calls).toHaveLength(0);
    });

    it('체크아웃이 체크인보다 빠르면 되묻는다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('오사카 호텔 11월 23일 체크인 11월 20일 체크아웃'),
      );

      expect(res.body.template.outputs[0].simpleText.text).toContain(
        '체크아웃(11월 20일)이 체크인(11월 23일)보다 빨라요',
      );
      expect(JSON.stringify(res.body)).not.toContain('/r/');
    });

    it('되묻기 버튼은 체크인·체크아웃 문장을 그대로 보낸다 — 누르면 평소 경로를 탄다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('오사카 호텔 11월 20일 체크인 11월 20일 체크아웃'),
      );

      const items = listCardOf(res.body).items as { action: string; messageText: string }[];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.action).toBe('message');
        // 연도를 박아 보낸다 — 안 박으면 그 문장이 또 굴러간다.
        expect(item.messageText).toMatch(/\d{4}년/);
        expect(item.messageText).toContain('체크인');
        expect(item.messageText).toContain('체크아웃');
      }
      // 첫 후보는 1박이다. 며칠 묵을지는 아무도 말하지 않았다.
      expect(items[0].messageText).toContain('11월 21일');

      // ⚠️ **버튼 문장이 그대로 통해야 한다.** 시킨 대로 보냈는데 또 되물으면 대화가 끊긴다.
      const next = await askUntilCard(ctx.app, items[0].messageText);
      expect(listCardOf(next).header.title).toContain('오사카 호텔');
    });

    it('1박 이상이면 평소대로 카드가 나간다', async () => {
      const body = await askUntilCard(
        ctx.app,
        '오사카 호텔 11월 20일 체크인 11월 21일 체크아웃',
      );

      expect(listCardOf(body).header.title).toContain('오사카 호텔');
    });
  });

  /**
   * **날짜·인원은 목록이 아니라 링크로 간다.**
   *
   * ⚠️ 기본 가짜 provider 는 `example.com` 주소를 준다 — 형식을 확인한 제휴몰이
   *    아니라서 조건이 안 붙고, 그래서 위 테스트들은 「반영되지 않았어요」를 본다.
   *    여기서는 **실제 상세 주소 꼴**을 줘서 붙는 쪽을 검증한다.
   */
  describe('상세 링크에 날짜·인원이 들어갈 때', () => {
    const detail = (i: number) => `https://kr.trip.com/hotels/detail/?cityId=219&hotelId=500731${i}`;

    beforeEach(() => {
      ctx.provider.reply = (query) =>
        Array.from({ length: 3 }, (_, i) => ({
          name: `${query.cityName} 호텔 ${i + 1}`,
          citySlug: query.citySlug,
          sourceUrl: detail(i),
          merchant: 'trip',
          priceFrom: 120000,
        }));
    });

    /**
     * ⚠️ **카드 줄은 `/r/{clickId}` 를 가리킨다.** 조건이 박힌 주소는 그 뒤에 있으므로
     *    (리다이렉트가 302 로 보낼 목적지) 카드 JSON 만 봐서는 검증되지 않는다.
     *    메모리에 남은 재료에서 꺼내 본다 — 리다이렉트가 보는 것과 같은 값이다.
     */
    it('링크 뒤의 실제 주소에 날짜·인원이 박힌다', async () => {
      const body = await askUntilCard(ctx.app, '오사카 호텔 11월 20일 체크인 11월 23일 체크아웃 3명');

      const linkUrl = listCardOf(body).items[0].link.web as string;
      const clickId = linkUrl.split('/r/')[1];
      const stored = ctx.app.get(MemoryStoreService).registerClick(clickId);

      const params = new URL(stored!.sourceUrl).searchParams;
      expect(params.get('checkIn')).toBe('2026-11-20');
      expect(params.get('checkOut')).toBe('2026-11-23');
      expect(params.get('adult')).toBe('3');
    });

    it('말한 날짜·인원을 링크에 넣고, 넣었다고 적는다', async () => {
      const body = await askUntilCard(ctx.app, '오사카 호텔 11월 20일 체크인 11월 23일 체크아웃 3명');
      const notice = noticeOf(body);

      expect(notice).toContain('11월 20일 체크인');
      expect(notice).toContain('11월 23일 체크아웃');
      expect(notice).toContain('3명');
      // ⚠️ **반영한 조건을 "반영되지 않았어요" 라고 적으면 안 된다.** 맞는 링크를
      //    받고도 틀렸다고 읽는다.
      expect(notice).not.toContain('반영되지 않았어요');
      // 목록은 여전히 지역으로만 찾는다 — 그래서 "검색돼요" 가 아니라 "열려요" 다.
      expect(notice).toContain('열려요');
    });

    it('아무 말 없으면 내일 체크인 · 1박 · 2명으로 적는다', async () => {
      const notice = noticeOf(await askUntilCard(ctx.app, '오사카 호텔 추천해줘'));

      const tomorrow = new Date(Date.now() + 86_400_000);
      const day = `${tomorrow.getMonth() + 1}월 ${tomorrow.getDate()}일`;
      expect(notice).toContain(`${day} 체크인`);
      expect(notice).toContain('2명으로 열려요');
    });

    it('6명을 넘으면 6명으로 맞추고 맞췄다고 알린다', async () => {
      const body = await askUntilCard(ctx.app, '오사카 호텔 8명');
      const notice = noticeOf(body);

      expect(notice).toContain('6명으로 열려요');
      expect(notice).toContain('인원은 6명까지만 넣을 수 있어 6명으로 맞췄어요.');
      // ⚠️ **말풍선을 새로 만들면 안 된다.** 셋이 한계라, 넘기면 멘션 버튼이 조용히
      //    잘린다. 이 안내는 기존 고지에 한 줄로 붙는다.
      expect(body.template.outputs.length).toBeLessThanOrEqual(3);
      expect(mentionCardOf(body)).toBeDefined();
    });

    /**
     * ⚠️ **조건은 저장된 주소가 아니라 그릴 때 붙는다.** 검색 결과는 지역으로만 갈려
     *    하루를 산다 — 주소에 날짜를 구워 저장하면 **내일 캐시를 맞은 사람이 어제
     *    날짜로 열린 페이지**를 받는다 (0004 와 같은 이유).
     */
    it('저장된 결과를 다시 꺼내도 그 사람이 말한 날짜로 열린다', async () => {
      await askUntilCard(ctx.app, '오사카 호텔 11월 20일 체크인 11월 23일 체크아웃');

      // 같은 도시를 **다른 날짜로** 다시 묻는다. 검색은 다시 돌지 않는다(캐시).
      const again = await askUntilCard(ctx.app, '오사카 호텔 12월 1일 체크인 12월 5일 체크아웃');

      expect(ctx.provider.calls).toHaveLength(1);
      expect(noticeOf(again)).toContain('12월 1일 체크인');
      expect(noticeOf(again)).not.toContain('11월 20일');
    });
  });

  it('호텔 카드에는 제휴 고지가 붙는다 — 누르기 전에 알아야 한다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');

    // 줄 링크는 우리 리다이렉트를 거쳐 애드픽 커미션 링크로 간다. 사용자는 그 사실을
    // 알 길이 없으므로 **카드 아래에 적는다.**
    expect(noticeOf(body)).toContain('본 검색 결과에는 제휴 업체가 포함되어 있습니다.');
    // ⚠️ 말풍선은 셋을 못 넘는다. 넘기면 멘션 버튼이 조용히 잘린다.
    expect(body.template.outputs).toHaveLength(3);
    expect(mentionCardOf(body)).toBeDefined();
  });

  it('제휴가 없는 관광지에는 제휴 고지를 붙이지 않는다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 관광지 추천해줘');

    // 관광지는 `/a/{id}` 로 바로 간다 — 제휴 변환 단계가 아예 없다.
    expect(noticeOf(body)).not.toContain('제휴 업체');
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

  // ---------------------------------------------------------- 공유하기
  /**
   * 공유 버튼은 서버로 아무것도 안 돌려준다 — 카카오 클라이언트가 공유창을 띄우고
   * 끝이라 label 과 action 외에 실을 것이 없다.
   */
  it('카드에 공유 버튼을 단다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');

    expect(shareButtonOf(body)).toEqual({ label: '공유하기', action: 'share' });
  });

  /**
   * ⚠️ **순서가 기능이다.** listCard 버튼은 2개가 한계고 템플릿이 slice(0, 2) 로
   *    조용히 자른다. 공유가 앞에 오면 넘칠 때 페이지 넘김이 사라진다.
   */
  it('더 보기가 공유보다 앞에 온다 — 넘치면 공유가 잘려야 한다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');

    expect(listCardOf(body).buttons.map((b: any) => b.label)).toEqual(['더 보기', '공유하기']);
  });

  it('마지막 페이지에도 공유 버튼은 남는다', async () => {
    const first = await askUntilCard(ctx.app, '오사카 호텔 추천해줘');
    const cacheKey = moreButtonOf(first).extra.cache_key;

    const last = await post(
      ctx.app,
      kakaoPayload('오사카 호텔 더 보기', { clientExtra: { cache_key: cacheKey, offset: 10 } }),
    );

    expect(moreButtonOf(last.body)).toBeUndefined();
    expect(shareButtonOf(last.body)).toBeDefined();
  });

  /**
   * ⚠️ **1차 필터가 도메인 단어를 다 품어야 한다.** 호텔·항공 단어로는 알면서 그 앞의
   *    필터에서 걸러 도움말을 줬다 — "오사카 료칸 추천", "부산 오사카 왕복" 이 그랬다.
   */
  it.each([
    ['오사카 료칸 추천해줘', '호텔'],
    ['오사카 호스텔 추천', '호텔'],
    ['부산 오사카 왕복', '항공권'],
    ['오사카 편도 알아봐줘', '항공권'],
  ])('"%s" 는 도움말이 아니라 %s 로 간다', async (utterance, label) => {
    const body = await askUntilCard(ctx.app, utterance);

    expect(listCardOf(body).header.title).toContain(label);
  });

  // ---------------------------------------------------------- 나라 → "다른 도시"
  /**
   * 나라 되묻기 카드가 「다른 도시를 찾고 있나요?」 라고 묻는다. 그 말 그대로 답하면
   * "다른 도시" 를 **지명으로 등록해 검색했다.** 되묻던 도메인을 이어받아야 한다.
   */
  it('나라 되묻기 뒤에 "다른 도시" 만 쳐도 도시 이름을 되묻는다 — 지명으로 검색하지 않는다', async () => {
    await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));

    const res = await post(ctx.app, kakaoPayload('다른 도시'));

    expect(textOf(res.body)).toContain('베트남 어디로 가세요?');
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('되묻던 중이 아니면 "다른 도시" 는 여전히 도움말이다', async () => {
    // 되묻기 상태는 사람마다 따로다. 앞 테스트가 남긴 상태와 섞이지 않게 다른 사람으로 묻는다.
    const res = await post(ctx.app, kakaoPayload('다른 도시', { userKey: 'nobody-waiting' }));

    expect(notUnderstoodCardOf(res.body)).toBeDefined();
  });

  // ---------------------------------------------------------- 항공권
  it('항공권도 listCard 다 — 그룹챗봇은 itemCard 를 못 그린다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 항공권 찾아줘');

    expect(JSON.stringify(body)).not.toContain('carousel');
    expect(JSON.stringify(body)).not.toContain('itemCard');
    expect(listCardOf(body).header.title).toContain('항공권');
  });

  /**
   * ⚠️ **항공권은 모델을 부르지 않는다.** 줄 링크는 어차피 우리가 IATA 코드로
   *    조립하므로, 시세 한 줄을 포기하면 검색할 것이 없다
   *    ([link-offers.ts](../src/modules/flight/link-offers.ts)).
   *    이게 깨지면 단톡방 질문마다 7~30초와 웹 검색 요금이 다시 나간다.
   */
  it('모델을 부르지 않고 바로 카드가 나온다', async () => {
    const res = await post(ctx.app, kakaoPayload('오사카 항공권 찾아줘'));

    // 한 번의 요청으로 카드가 나왔다 — "찾고 있어요" 도 콜백도 없다.
    expect(listCardOf(res.body)).toBeDefined();
    // 모델을 부르는 길 자체가 없다. OpenAI 는 의도 파싱에만 쓰인다.
    expect(ctx.openai.calls).toHaveLength(0);
  });

  it('출발지를 말하지 않으면 서울 출발로 보고 그 사실을 적는다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 항공권 찾아줘');

    expect(noticeOf(body)).toContain('서울 출발 기준');
    expect(listCardOf(body).header.title).toContain('서울→오사카');
  });

  /**
   * ⚠️ 조사 없이 "부산 하노이" 로 들어온다. 이게 안 되면 부산 사람이 서울 출발
   *    항공권을 받고, 출발지를 추측했다는 고지조차 안 붙어 고칠 단서가 없다.
   */
  it('조사 없이 말한 출발지도 읽는다 — "부산 하노이 항공권"', async () => {
    const body = await askUntilCard(ctx.app, '부산 하노이 항공권 찾아줘');

    expect(listCardOf(body).header.title).toContain('부산→하노이');
    expect(noticeOf(body)).not.toContain('출발 기준');
  });

  /**
   * ⚠️ **반영한 조건을 "반영하지 않았어요" 라고 적으면 안 된다.** 맞는 링크를 받고도
   *    틀렸다고 읽는다. 날짜·인원은 이제 링크에 들어가므로 고지에서 빠져야 한다.
   */
  it('말한 날짜·인원을 고지에 그대로 적는다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 항공권 10월 20일~24일 4명');

    const notice = noticeOf(body);
    expect(notice).toContain('10월 20일 출발');
    expect(notice).toContain('24일 귀국');
    expect(notice).toContain('4인');
    expect(notice).not.toContain('반영되지 않았어요');
  });

  it('편도는 귀국일 없이 연다', async () => {
    const body = await askUntilCard(ctx.app, '오사카 편도 항공권 찾아줘');

    expect(noticeOf(body)).toContain('편도');
    expect(noticeOf(body)).not.toContain('귀국');
  });

  /**
   * **잘못된 날짜를 조용히 바꾸지 않는다.**
   *
   * 운영에서 "11월 23일 출발 11월 20일 귀국" 이 **11월 30일 귀국**으로 검색된다고
   * 안내했고(출발일 + 7일), "2026년 10월 20일" 은 2027년으로 나갔다. 둘 다 사용자가
   * 말한 적 없는 날짜의 링크이고, 카드 안내는 연도를 안 찍어서 7번은 드러나지도 않았다.
   *
   * ⚠️ 카카오에는 날짜 선택 버튼이 없다. 후보를 `message` 버튼으로 내놓는 것이 전부다.
   */
  describe('날짜가 잘못됐을 때', () => {
    it('귀국일이 출발일보다 빠르면 링크 대신 되묻는다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('서울에서 도쿄 항공권 11월 23일 출발 11월 20일 귀국'),
      );

      // 이유는 말풍선에 온전히 싣는다. 리스트 헤더는 카카오가 한 줄만 보여주고 「…」로 자른다.
      expect(res.body.template.outputs[0].simpleText.text).toContain(
        '귀국일(11월 20일)이 출발일(11월 23일)보다 빨라요',
      );
      const card = listCardOf(res.body);
      expect(card.header.title).toBe('날짜를 다시 골라주세요');
      // ⚠️ **링크를 주면 안 된다.** 날짜에 동의하기 전이다.
      expect(JSON.stringify(res.body)).not.toContain('/r/');
      // 멋대로 고른 날짜(출발일 + 7일 = 11월 30일)가 결과처럼 나가서도 안 된다.
      expect(JSON.stringify(res.body)).not.toContain('11월 30일');
    });

    it('되묻기 버튼은 고쳐진 문장을 그대로 보낸다 — 누르면 평소 경로를 탄다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('서울에서 도쿄 항공권 11월 23일 출발 11월 20일 귀국'),
      );

      const items = listCardOf(res.body).items as { action: string; messageText: string }[];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.action).toBe('message');
        // 연도를 박아 보낸다 — 안 박으면 그 문장이 또 굴러간다.
        expect(item.messageText).toMatch(/\d{4}년/);
      }
      // 가장 흔한 의도는 두 날짜를 바꿔 끼우는 것이다.
      expect(items[0].messageText).toContain('11월 20일 출발');
      expect(items[0].messageText).toContain('11월 23일 귀국');
    });

    /**
     * ⚠️ **예문은 그 자체로 통하는 문장이어야 한다.**
     *
     * 처음에는 날짜만 적어 「11월 20일 출발 11월 23일 귀국」이라고 안내했다. 그 문장에는
     * 여행 신호가 없어서 1차 필터(TRAVEL_HINT)에서 떨어지고 **모델에 가기도 전에**
     * "어떤 여행을 찾으시나요?" 가 나갔다 — 시킨 대로 보낸 사람이 이해 못 했다는 답을
     * 받았다. 되묻기 카드가 막다른 길이 되는 최악의 경우다.
     */
    it('안내 예문을 그대로 보내도 통한다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('서울에서 도쿄 항공권 11월 23일 출발 11월 20일 귀국'),
      );

      const tail = res.body.template.outputs[2].textCard.description as string;
      const example = /「(.+?)」/s.exec(tail)![1];
      expect(example).toContain('서울에서 도쿄 항공권');

      // 예문을 그대로 보내면 되묻기가 아니라 평소 경로를 타야 한다.
      const again = await post(ctx.app, kakaoPayload(example));
      expect(JSON.stringify(again.body)).not.toContain('어떤 여행을 찾으시나요');
      expect(JSON.stringify(again.body)).not.toContain('빨라요');
    });

    /** 버튼이 보내는 문장도 같은 기준이다. 연도까지 박아서 다시 굴러가지 않게 한다. */
    it('되묻기 버튼 문장도 그대로 통한다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('서울에서 도쿄 항공권 11월 23일 출발 11월 20일 귀국'),
      );

      const items = listCardOf(res.body).items as { messageText: string }[];
      const again = await post(ctx.app, kakaoPayload(items[0].messageText));
      expect(JSON.stringify(again.body)).not.toContain('어떤 여행을 찾으시나요');
      expect(JSON.stringify(again.body)).not.toContain('빨라요');
    });

    it('연도를 적은 지난 날짜는 다음 해로 바꾸지 않고 되묻는다', async () => {
      const res = await post(
        ctx.app,
        kakaoPayload('서울에서 도쿄 항공권 2020년 10월 20일 출발 2020년 10월 23일 귀국'),
      );

      const reason = res.body.template.outputs[0].simpleText.text as string;
      expect(reason).toContain('지난 날짜');
      expect(reason).toContain('2020년');
      expect(listCardOf(res.body).header.title).toBe('날짜를 다시 골라주세요');
      expect(JSON.stringify(res.body)).not.toContain('/r/');
    });

    it('멀쩡한 날짜는 평소대로 카드가 나간다', async () => {
      const body = await askUntilCard(ctx.app, '서울에서 도쿄 항공권 12월 20일 출발 12월 23일 귀국');

      expect(listCardOf(body).header.title).toContain('항공권');
    });
  });

  // ---------------------------------------------------------- 관광지
  // ---------------------------------------------------------- 항공권 — 만들 수 없는 노선
  /**
   * ⚠️ **조용히 고치지 않는다.** 예전에는 "서울 항공권" 에 서울→서울 카드가,
   *    "강릉에서 제주" 에 머리글은 강릉인데 링크는 김포로 열리는 카드가 나갔다.
   */
  it('출발지와 도착지가 같으면 링크 대신 출발지를 묻는다 — "서울 항공권"', async () => {
    const res = await post(ctx.app, kakaoPayload('서울 항공권 찾아줘'));

    expect(textOf(res.body)).toContain('서울 출발 기준이라 출발지와 도착지가 같아요');
    expect(textOf(res.body)).toContain('「부산에서 서울 항공권」');
  });

  it('공항 없는 출발지는 서울로 바꾸지 않고 다시 묻는다 — "강릉에서 제주"', async () => {
    const res = await post(ctx.app, kakaoPayload('강릉에서 제주 항공권 찾아줘'));

    expect(textOf(res.body)).toContain('강릉에는 공항이 없어 출발지로 쓸 수 없어요');
    expect(JSON.stringify(res.body)).not.toContain('listCard');
  });

  it('공항 없는 도착지는 "다시 물어봐 주세요" 가 아니라 무엇을 바꿀지 알려준다', async () => {
    const res = await post(ctx.app, kakaoPayload('유후인 항공권 찾아줘'));

    expect(textOf(res.body)).toContain('유후인에는 공항이 없어 항공권 링크를 만들 수 없어요');
    expect(textOf(res.body)).not.toContain('잠시 뒤');
  });

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

  /**
   * ⚠️ **"도쿄 신주쿠 호텔" 이 도쿄 호텔로 검색되고 있었다.**
   *
   * 사전이 도시를 찾으면 거기서 확정하고 나머지를 버렸다. 사용자는 신주쿠를
   * 물었는데 도쿄 결과를 받았고, 카드에도 "도쿄 호텔" 이라고만 적혀 있어서
   * 자기가 물은 것과 다른 답이라는 걸 알아챌 단서가 없었다.
   */
  it('도시를 같이 말한 세부 지역도 세부 지역으로 찾는다 — "도쿄 신주쿠"', async () => {
    await askUntilCard(ctx.app, '도쿄 신주쿠 호텔 찾아줘');

    expect(ctx.provider.calls[0]).toMatchObject({
      citySlug: 'shinjuku',
      // 세부 지역만 주면 모델이 어디인지 모른다. 부모 도시를 붙여야 검색이 된다.
      cityName: '신주쿠 도쿄',
    });
  });

  /**
   * ⚠️ **요청 경로의 모델 호출은 많아야 한 번이다.**
   *
   * 사전에 없는 지명은 예전에 두 번 탔다 — 발화에서 지명을 뽑는 데 한 번,
   * 그 지명이 어디인지 묻는 데 또 한 번. 둘 다 최대 4초인데 **직렬**이라 카카오
   * 5초 예산을 넘겼고, 그때 사용자는 아무 말풍선도 못 받았다. 이 테스트가
   * 그 왕복이 되살아나는 것을 막는다.
   */
  it('사전에 없는 지명이어도 모델은 한 번만 탄다', async () => {
    await post(ctx.app, kakaoPayload('도쿄 기타센주 호텔 찾아줘. 11월 10일 체크인, 성인 2명'));
    await new Promise((r) => setTimeout(r, 150));

    expect(ctx.openai.calls.map((c: any) => c.format?.name)).toEqual(['parsed_intent']);
  });

  it('사전에 있는 동네는 모델을 아예 안 탄다 — "도쿄 신주쿠 호텔"', async () => {
    await post(ctx.app, kakaoPayload('도쿄 신주쿠 호텔 찾아줘'));
    await new Promise((r) => setTimeout(r, 150));

    // 발화 해석도 지역 정규화도 사전에서 끝난다. 응답 예산을 넘길 자리가 없다 —
    // 이 발화가 "어떤 여행을 찾으시나요?" 를 받던 것이 수정 요청 3번이다.
    expect(ctx.openai.calls.map((c: any) => c.format?.name)).not.toContain('parsed_intent');
  });

  // ---------------------------------------------------------- 나라
  it('나라를 말하면 그 나라의 도시로 되묻는다', async () => {
    const res = await post(ctx.app, kakaoPayload('베트남 여행지 추천해줘'));
    const card = listCardOf(res.body);

    expect(card.header.title).toBe('베트남 어느 도시의 관광지를 찾을까요?');
    // ⚠️ 예전에는 베트남을 물어도 오사카·도쿄·후쿠오카를 권했다. 딴소리였다.
    expect(card.items.map((i: any) => i.title)).toEqual(['다낭', '하노이', '호치민', '나트랑']);
    // 처음 가는 사람은 도시 이름만 보고 못 고른다.
    expect(card.items[0].description).toBe('미케 · 한강');
    // ⚠️ 줄을 누르면 **완성된 문장**이 전송된다 — 단톡방에서 멘션을 빼먹을 일이 없다.
    expect(card.items[0]).toMatchObject({
      action: 'message',
      messageText: '다낭 관광지 추천해줘',
    });
    // 검색은 돌지 않는다 — 나라 단위 결과는 도시가 섞여 쓸모가 없다.
    expect(ctx.attractionProvider.calls).toHaveLength(0);
  });

  it('카드 뒤에 "다른 도시" 안내가 멘션 버튼과 함께 따라온다', async () => {
    const res = await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));
    const outputs = res.body.template.outputs;

    expect(outputs).toHaveLength(2);
    const guide = outputs[1].textCard;
    expect(guide.description).toContain('다른 도시를 찾고 있나요?');
    // 나라와 상관없는 도시를 예로 들면 안내가 아니라 딴소리다.
    expect(guide.description).toContain('「하롱베이 호텔 추천해줘」');
    // ⚠️ **예문에서 @봇이름 을 뺀다.** 버튼이 멘션을 넣어주는데 예문에도 적어두면
    //    그대로 따라 친 사람의 입력창에 멘션이 두 번 들어간다.
    expect(guide.description).not.toContain('@가자고');
    expect(guide.buttons).toEqual([{ label: '@가자고 TST', action: 'mention' }]);
  });

  it('항공권은 줄에 출발지까지 박는다 — 누르면 되묻기가 또 생기지 않는다', async () => {
    const res = await post(ctx.app, kakaoPayload('베트남 항공권 찾아줘'));

    expect(listCardOf(res.body).items[0].messageText).toBe('서울에서 다낭 항공권 찾아줘');
  });

  it('줄을 누르면 그대로 그 도시 검색이 된다', async () => {
    const res = await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));
    const first = listCardOf(res.body).items[0];

    const body = await askUntilCard(ctx.app, String(first.messageText));

    expect(listCardOf(body).header.title).toContain('다낭');
  });

  it('저장된 도시가 모자라면 모델로 채운다', async () => {
    // ⚠️ 운영에서 "중국 어느 도시…" 카드에 **도시가 둘**만, 그것도 설명 없이 나갔다.
    //    사전 경로로 먼저 등록된 도시는 순서도 설명도 없이 들어오기 때문이다.
    const res = await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));
    const items = listCardOf(res.body).items;

    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.every((i: any) => i.description)).toBe(true);
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

    expect(listCardOf(res.body).header.title).toContain('일본 어느 도시');
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

  it('"다른 도시" 를 누르면 도시 이름만 받아서 이어 검색한다', async () => {
    // ⚠️ 카카오에는 입력창을 미리 채우는 버튼이 없다. 그래서 한 번 되묻고 다음 발화를 받는다.
    const asked = await post(ctx.app, kakaoPayload('호텔 다른 도시'));
    // ⚠️ 멘션을 빼먹으면 봇이 못 듣는다. 안내에 그 방법이 들어가야 한다.
    expect(textOf(asked.body)).toMatch(/도시 이름을 보내주세요|멘션/);

    // 사용자가 도시 이름만 보낸다. "다낭" 에는 여행 신호가 없어서 원래는 도움말로 떨어진다.
    const body = await askUntilCard(ctx.app, '다낭');

    expect(listCardOf(body).header.title).toContain('다낭');
  });

  it('멘션만 온 발화도 되묻기를 이어간다 — 버튼이 전송돼 버려도 대화가 안 끊긴다', async () => {
    await post(ctx.app, kakaoPayload('베트남 호텔 추천해줘'));

    // "@가자고 " 버튼이 프리필 대신 전송된 경우. 멘션을 떼면 빈 발화가 된다.
    const res = await post(ctx.app, kakaoPayload('@가자고'));

    expect(textOf(res.body)).toContain('베트남');
    expect(textOf(res.body)).toMatch(/도시 이름|어디로/);
  });

  it('되묻기는 사람마다 따로다 — 남의 대답을 가로채지 않는다', async () => {
    await post(ctx.app, kakaoPayload('호텔 다른 도시', { userKey: 'a' }));

    const stranger = await post(ctx.app, kakaoPayload('다낭', { userKey: 'b' }));

    // B 는 되묻기를 받은 적이 없다. 그냥 안내 카드가 나가야 한다.
    expect(notUnderstoodCardOf(stranger.body)).toBeDefined();
  });

  it('되묻기 상태여도 새 질문은 새 질문으로 받는다', async () => {
    // ⚠️ 중국 되묻기 뒤에 "일본여행지" 를 쳤더니 그걸 중국의 도시 이름으로 받아
    //    "일본여행지 호텔을 찾고 있어요" 가 나갔다. 도메인 말이 붙어 있으면 새 질문이다.
    await post(ctx.app, kakaoPayload('중국 호텔 추천해줘'));

    const res = await post(ctx.app, kakaoPayload('일본여행지'));

    expect(listCardOf(res.body).header.title).toBe('일본 어느 도시의 관광지를 찾을까요?');
  });

  it('되묻기 상태여도 지명 같지 않은 말은 받지 않는다', async () => {
    await post(ctx.app, kakaoPayload('관광지 다른 도시'));

    const res = await post(ctx.app, kakaoPayload('ㅋㅋㅋ 거기 어디였지?'));

    // 아무 말이나 지명으로 등록하면 places 가 쓰레기로 찬다.
    expect(notUnderstoodCardOf(res.body)).toBeDefined();
  });

  /**
   * ⚠️ **되묻기 뒤의 짧은 잡담을 지명으로 받지 않는다.**
   *
   * 운영에서 되묻기 5분 안에 「점심뭐먹지」를 쳤더니 그게 지역으로 등록되고 관광지 검색까지
   * 돌았다 — 「응, 잠시만 기다려 줘」 뒤에 「점심뭐먹지 관광지 정보를 지금은 정리하지 못했어요」.
   * 짧고 띄어쓰기가 없어서 지명 모양 검사를 통과했고, 모델이 "지명이 아니다" 라고 답했는데도
   * 원문 그대로 등록했다.
   */
  it('되묻기 뒤 「점심뭐먹지」는 지명이 아니다 — 검색하지 않고 도움말을 준다', async () => {
    const user = { userKey: 'lunch' };
    await post(ctx.app, kakaoPayload('관광지 추천해줘', user));

    const res = await post(ctx.app, kakaoPayload('점심뭐먹지', user));

    expect(notUnderstoodCardOf(res.body)).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('점심뭐먹지 관광지');
    expect(JSON.stringify(res.body)).not.toContain('찾고 있어요');

    // 기다리던 질문은 살아 있다 — 이어서 지명을 말하면 받는다.
    const body = await askUntilCard(ctx.app, '다낭', user);
    expect(listCardOf(body).header.title).toContain('다낭');
  });

  it('되묻기 대답에서 모델이 실패하면 예전처럼 검색해 본다 — 느린 날 진짜 도시를 버리지 않는다', async () => {
    const user = { userKey: 'slow-model' };
    await post(ctx.app, kakaoPayload('호텔 추천해줘', user));

    ctx.openai.failNext = true;
    const res = await post(ctx.app, kakaoPayload('코타키나발루', user));

    expect(notUnderstoodCardOf(res.body)).toBeUndefined();
    expect(JSON.stringify(res.body)).toContain('코타키나발루');
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

  /**
   * ⚠️ **키가 거부된 것과 검색이 터진 것은 할 말이 다르다.** 전자는 고치기 전엔 영영
   *    안 되므로 "잠시 뒤 다시" 는 거짓말이고, 사용자는 그 사이 같은 질문만 반복한다.
   *    2026-11-04 에 실제로 그랬다 (.env 의 키가 꼬리 한 글자 붙어 저장됨 → 401).
   */
  it('자격증명이 거부되면 "잠시 뒤 다시" 라고 하지 않는다', async () => {
    ctx.provider.reply = () => {
      throw new OpenAiHttpError(401, '{"error":{"code":"invalid_api_key"}}');
    };

    const receiver = await callbackReceiver();
    try {
      await post(ctx.app, kakaoPayload('나고야 호텔 추천해줘', { callbackUrl: receiver.url }));

      const text = textOf(await receiver.received);
      expect(text).toContain('안 되고 있어요');
      // "잠시 뒤 다시 시도해 주세요" — 키를 고치기 전엔 영영 안 되는 안내다.
      expect(text).not.toContain('잠시 뒤');
    } finally {
      await receiver.close();
    }
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

  /**
   * 검색 전체 타임아웃.
   *
   * ⚠️ 모델 호출마다 걸린 60초로는 못 막는다 — 2단 호출 + 썸네일이면 합이 콜백 URL
   *    수명(5분)을 넘길 수 있고, 그러면 URL 이 만료돼 사용자는 "찾고 있어요" 만
   *    보고 끝난다. **침묵보다 실패 카드가 낫다.**
   */
  /**
   * **빈손일 때 막다른 길을 주지 않는다.**
   *
   * 빈 결과는 `FAILED_TTL_MINUTES` 동안 굳는다(연속 2회부터). 그동안 같은 말을
   * 반복하면 검색조차 안 하고 같은 문구만 돌아오므로, "잠시 뒤 다시" 만 주면
   * 사용자는 봇이 고장 난 줄 안다. **지역을 좁히면 캐시 키가 달라져 실제로
   * 다른 길이 열린다** — 그걸 알려준다.
   */
  describe('검색이 빈손일 때', () => {
    async function withEmptySearch(run: () => Promise<any>) {
      ctx.provider.reply = () => [];
      try {
        return await run();
      } finally {
        ctx.provider.reset();
      }
    }

    /**
     * **호텔은 빈손이어도 줄 것이 있다.**
     *
     * 모델이 빈손으로 돌아오는 건 막을 수 없지만(허용 호스트 밖 링크만 주거나 웹
     * 검색을 건너뛴다) 사용자가 원래 하려던 일 — 그 지역 호텔 보기 — 는 우리가
     * 모델 없이 해줄 수 있다. "정리하지 못했어요" 는 막다른 길이다.
     */
    it('호텔은 직접 만든 검색 링크로 길을 열어준다', async () => {
      await withEmptySearch(async () => {
        // 첫 요청이 검색을 띄우고, 빈손이 저장된 뒤 두 번째 요청이 그 응답을 받는다.
        await post(ctx.app, kakaoPayload('오사카 호텔 11월 20일 체크인 11월 23일 체크아웃 2명'));
        await new Promise((r) => setTimeout(r, 120));
        const res = await post(
          ctx.app,
          kakaoPayload('오사카 호텔 11월 20일 체크인 11월 23일 체크아웃 2명'),
        );

        const card = listCardOf(res.body);
        expect(card.header.title).toContain('오사카');
        const titles = (card.items as { title: string }[]).map((i) => i.title);
        expect(titles.join(' ')).toContain('호텔스닷컴');
        // 마이리얼트립은 링크가 차단돼 뺐다.
        expect(titles.join(' ')).not.toContain('마이리얼트립');

        // ⚠️ 왜 추천이 아니라 검색 링크인지 말해야 한다. 안 그러면 품질이 갑자기
        //    나빠진 것처럼 보인다. 제휴 고지도 같이 나간다.
        const notice = noticeOf(res.body);
        expect(notice).toContain('추천 목록을 정리하지 못해');
        expect(notice).toContain('제휴 업체');

        // 줄 링크는 우리 리다이렉트를 거쳐야 클릭이 집계되고 수수료가 붙는다.
        for (const item of card.items as { link?: { web: string } }[]) {
          expect(item.link?.web).toContain('/r/');
        }
      });
    });

    /**
     * ⚠️ **링크 줄은 결과가 아니다.** 저장하면 그 지역은 TTL 동안 AI 검색을 다시
     *    안 하고 영영 링크 두 줄만 나간다 — 행은 빈손으로 두고 화면만 채운다.
     *
     * 저장하지 않았다는 건 **페이지가 생기지 않는 것**으로 드러난다. 저장된 결과는
     * 20건을 5건씩 끊어 "더 보기" 가 붙는데, 이 줄들은 그 경로를 타지 않는다.
     * 그리고 빈손이 굳어 있는 동안 모델을 다시 때리지도 않는다.
     */
    it('검색 링크를 결과로 저장하지 않는다', async () => {
      await withEmptySearch(async () => {
        await post(ctx.app, kakaoPayload('삿포로 호텔 추천해줘'));
        await new Promise((r) => setTimeout(r, 120));
        const calls = ctx.provider.calls.length;

        const res = await post(ctx.app, kakaoPayload('삿포로 호텔 추천해줘'));
        const card = listCardOf(res.body);

        // 페이지가 없다 — 저장된 결과가 아니기 때문이다.
        const labels = ((card.buttons ?? []) as { label: string }[]).map((b) => b.label);
        expect(labels).not.toContain('더 보기');
        // 빈손이 굳어 있는 동안 모델을 또 부르지 않는다.
        expect(ctx.provider.calls).toHaveLength(calls);
      });
    });

    it('관광지는 지역을 좁혀 보라는 출구를 준다', async () => {
      const { emptyText } = await import('../src/modules/kakao/cards');
      const text = JSON.stringify(
        emptyText(
          { kind: 'attraction', placeName: '오사카', placeSlug: 'osaka' } as any,
          null,
        ),
      );

      expect(text).toContain('정리하지 못했어요');
      expect(text).toContain('동네 이름을 붙여');
    });

    /** ⚠️ 이미 동네를 말한 사람에게 동네를 말하라고 하면 안 된다. 시킨 대로 이미 했다. */
    it('세부 지역을 말한 사람에게는 그 출구를 권하지 않는다', async () => {
      const { emptyText } = await import('../src/modules/kakao/cards');
      const text = JSON.stringify(
        emptyText(
          { kind: 'attraction', placeName: '신주쿠', placeSlug: 'shinjuku', placeKind: 'area' } as any,
          null,
        ),
      );

      expect(text).toContain('정리하지 못했어요');
      expect(text).not.toContain('동네 이름');
    });

    /**
     * ⚠️ 항공권은 노선이 이미 확정이라 좁힐 자리가 없다. 권하면 딴소리가 된다 —
     *    "서울→오사카 항공권" 에 동네 이름을 붙일 방법이 없다.
     */
    it('항공권에는 그 출구를 권하지 않는다', async () => {
      const { emptyText } = await import('../src/modules/kakao/cards');
      const text = JSON.stringify(
        emptyText(
          { kind: 'flight', placeName: '오사카', placeSlug: 'osaka', fromName: '서울' } as any,
          null,
        ),
      );

      expect(text).toContain('정리하지 못했어요');
      expect(text).not.toContain('동네 이름');
    });
  });

  /**
   * **"가끔 대답을 안 한다" 의 정체.**
   *
   * 카카오는 5초를 넘긴 응답을 버린다. 그때 사용자가 받는 건 오류 메시지가 아니라
   * **아무것도 아니다** — 단톡방에서는 봇이 질문을 무시한 것처럼 보인다. 서버가
   * 뒤늦게 완벽한 카드를 만들어봐야 배달될 곳이 없으므로, 그 전에 끊어야 한다.
   */
  describe('예산을 넘길 때', () => {
    /** 느린 파서 + 짧은 예산. 설정 객체를 그대로 고쳐 쓰고 끝나면 되돌린다. */
    async function withTightBudget(budgetMs: number, parseMs: number, run: () => Promise<void>) {
      const config = ctx.app.get<AppConfig>(CONFIG);
      const original = config.kakaoBudgetMs;
      config.kakaoBudgetMs = budgetMs;
      ctx.openai.delayMs = parseMs;
      try {
        await run();
      } finally {
        config.kakaoBudgetMs = original;
        ctx.openai.delayMs = 0;
      }
    }

    it('콜백이 꺼져 있으면 "정리 중" 이라고 말한다 — 못 알아들은 게 아니다', async () => {
      await withTightBudget(30, 300, async () => {
        // 사전에 없는 지명이라 모델 경로를 탄다 — 그 모델이 느리다.
        const res = await post(ctx.app, kakaoPayload('@가자고 기타센주 호텔 추천해줘'));

        expect(res.status).toBe(201);
        const text = JSON.stringify(res.body);
        // ⚠️ **"어떤 여행을 찾으시나요?" 를 쓰면 안 된다.** 질문은 멀쩡했고 우리가
        //    늦었을 뿐인데, 그 문구는 사용자에게 자기 문장이 틀렸다고 읽힌다 —
        //    실제로 멀쩡한 질문을 다르게 바꿔 치며 헤매게 만들었다.
        expect(text).not.toContain('어떤 여행을 찾으시나요');
        expect(text).toContain('정리 중');
        // ⚠️ 탓하지 않는다. 늦은 건 서버 사정이고 질문은 멀쩡했다.
        expect(text).not.toMatch(/잘못|오류|실패/);
      });
    });

    it('콜백이 켜져 있으면 늦은 답을 콜백으로 민다 — 버리지 않는다', async () => {
      const receiver = await callbackReceiver();
      try {
        await withTightBudget(30, 300, async () => {
          const res = await post(
            ctx.app,
            kakaoPayload('@가자고 기타센주 호텔 추천해줘', { callbackUrl: receiver.url }),
          );

          expect(res.status).toBe(201);
          // 지금 줄 수 있는 건 "기다려" 뿐이고, 진짜 답은 콜백으로 간다.
          expect(res.body.useCallback).toBe(true);
          expect(JSON.stringify(res.body)).not.toContain('어떤 여행을 찾으시나요');

          // ⚠️ **콜백 URL 은 1회용이다.** 예산 가드와 백그라운드 검색이 각자 쏘면
          //    하나는 버려진다. 밀린 것이 "못 알아들었다" 가 아니어야 한다.
          const pushed = await receiver.received;
          expect(JSON.stringify(pushed)).not.toContain('어떤 여행을 찾으시나요');
        });
      } finally {
        await receiver.close();
      }
    });

    it('예산 안에 끝나면 평소대로 답한다 — 가드는 늦을 때만 돈다', async () => {
      await withTightBudget(2000, 0, async () => {
        const res = await post(ctx.app, kakaoPayload('@가자고 오사카 호텔 추천해줘'));

        expect(res.status).toBe(201);
        expect(JSON.stringify(res.body)).not.toContain('어떤 여행을 찾으시나요');
      });
    });

    /**
     * ⚠️ **하던 일을 멈추지 않는다.** 사용자가 실제로 하는 행동은 같은 질문을 다시
     *    하는 것이고, 그때 캐시가 차 있으면 카드가 바로 나간다. 끊었다고 검색까지
     *    버리면 두 번째 질문도 똑같이 느리다.
     */
    it('끊어도 진행 중이던 일은 끝난다', async () => {
      await withTightBudget(30, 120, async () => {
        await post(ctx.app, kakaoPayload('@가자고 기타센주 호텔 추천해줘'));
        expect(ctx.openai.calls).toHaveLength(1);
      });

      // 파서가 뒤에서 끝나 의도 캐시에 남았다 → 같은 문장을 다시 물으면 모델이 안 돈다.
      await new Promise((r) => setTimeout(r, 200));
      const before = ctx.openai.calls.length;
      await post(ctx.app, kakaoPayload('@가자고 기타센주 호텔 추천해줘'));

      expect(ctx.openai.calls.length).toBe(before);
    });

    it('0 이면 가드를 끈다 — 진단할 때 끝까지 기다려 본다', async () => {
      await withTightBudget(0, 50, async () => {
        const res = await post(ctx.app, kakaoPayload('@가자고 오사카 호텔 추천해줘'));

        expect(res.status).toBe(201);
        expect(JSON.stringify(res.body)).not.toContain('어떤 여행을 찾으시나요');
      });
    });
  });

  describe('검색이 너무 오래 걸릴 때', () => {
    /** 느린 검색 + 짧은 타임아웃. 설정 객체를 그대로 고쳐 쓰고 끝나면 되돌린다. */
    async function withSlowSearch(run: (receiver: any) => Promise<void>) {
      const config = ctx.app.get<AppConfig>(CONFIG);
      const original = config.searchTimeoutMs;
      config.searchTimeoutMs = 30;
      ctx.provider.delayMs = 300;
      const receiver = await callbackReceiver();
      try {
        await run(receiver);
      } finally {
        config.searchTimeoutMs = original;
        await receiver.close();
      }
    }

    it('기다리기를 그만두고 실패 카드를 보낸다 — 침묵보다 낫다', async () => {
      await withSlowSearch(async (receiver) => {
        await post(
          ctx.app,
          kakaoPayload('후쿠오카 호텔 추천해줘', { callbackUrl: receiver.url }),
        );

        const pushed = await receiver.received;
        expect(textOf(pushed)).toContain('불러오지 못했어요');
      });
    });

    it('**푸시는 한 번뿐이다** — 콜백 URL 은 1회용이라 두 번째는 버려진다', async () => {
      await withSlowSearch(async (receiver) => {
        await post(
          ctx.app,
          kakaoPayload('후쿠오카 호텔 추천해줘', { callbackUrl: receiver.url }),
        );
        await receiver.received;

        // 늦게 끝난 검색이 카드를 또 밀지 않는지. 검색(300ms)이 끝나고도 남게 기다린다.
        await new Promise((r) => setTimeout(r, 400));
        expect(receiver.bodies).toHaveLength(1);
      });
    });

    it('늦게 끝난 결과는 저장해둔다 — 다시 물으면 바로 나간다', async () => {
      await withSlowSearch(async (receiver) => {
        await post(
          ctx.app,
          kakaoPayload('후쿠오카 호텔 추천해줘', { callbackUrl: receiver.url }),
        );
        await receiver.received;
        await new Promise((r) => setTimeout(r, 400));

        // 돈과 시간을 이미 썼다. 버리면 사용자가 또 그만큼 기다린다.
        const body = await post(ctx.app, kakaoPayload('후쿠오카 호텔 추천해줘'));
        expect(listCardOf(body.body).items).toHaveLength(5);
        expect(ctx.provider.calls).toHaveLength(1);
      });
    });
  });
});

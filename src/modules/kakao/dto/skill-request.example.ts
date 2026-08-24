/**
 * Swagger "Try it out" 에 바로 채워지는 예시 요청.
 *
 * 카카오 오픈빌더가 실제로 보내는 형태를 그대로 뒀다.
 * 문서를 열자마자 Execute 를 누르면 동작하는 게 목적이라 값이 다 채워져 있다.
 */
export const SKILL_REQUEST_EXAMPLE = {
  intent: { id: 'intent-1', name: '호텔추천' },
  userRequest: {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: 'block-1', name: '호텔추천' },
    utterance: '오사카 호텔 추천해줘',
    lang: 'kr',
    user: {
      id: 'swagger-test',
      type: 'accountId',
      properties: { botUserKey: 'swagger-test' },
    },
  },
  bot: { id: 'bot-1', name: '여행봇' },
  action: {
    id: 'action-1',
    name: '호텔추천액션',
    // 오픈빌더 엔티티가 도시를 뽑아주면 여기 들어온다.
    // 비어 있어도 서버가 발화 텍스트에서 폴백 파싱한다.
    params: {},
    detailParams: {},
    clientExtra: {},
  },
};

/**
 * 콜백을 켠 블록이 보내는 요청.
 *
 * 오픈빌더에서 [콜백 사용] 을 켜면 `userRequest.callbackUrl` 이 실려 온다.
 * 스웨거에서 이걸로 Execute 하면 useCallback 응답이 오고, 잠시 뒤 저 주소로
 * 진짜 카드가 POST 된다 — 받을 서버가 없으면 전송 실패 로그만 남는다.
 */
export const SKILL_REQUEST_WITH_CALLBACK_EXAMPLE = {
  ...SKILL_REQUEST_EXAMPLE,
  userRequest: {
    ...SKILL_REQUEST_EXAMPLE.userRequest,
    callbackUrl: 'https://bot-api.kakao.com/v1/bots/xxx/callback/yyy',
  },
};

/**
 * 캐시 미스 + 콜백 켜짐. **첫 요청의 기본 응답이다.**
 *
 * template 이 아니라 data 를 쓴다. 진짜 카드는 callbackUrl 로 따로 간다.
 */
export const CALLBACK_ACK_EXAMPLE = {
  version: '2.0',
  useCallback: true,
  data: { text: '오사카 호텔을 찾고 있어요. 잠시만요 🔍' },
};

/** 캐시 미스 + 콜백 꺼짐. 검색은 백그라운드로 돌고, 다시 물으면 카드가 나온다. */
export const SEARCH_STARTED_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      { simpleText: { text: '오사카 호텔을 찾고 있어요 🔍\n30초쯤 뒤에 다시 물어봐 주세요!' } },
    ],
    quickReplies: [
      { label: '도쿄 호텔', action: 'message', messageText: '도쿄 호텔 추천해줘' },
    ],
  },
};

/** 도시를 못 알아들었을 때. */
export const ASK_CITY_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [{ simpleText: { text: '어느 도시 호텔을 찾으세요?\n예) 오사카 호텔 추천해줘' } }],
    quickReplies: [
      { label: '오사카 호텔', action: 'message', messageText: '오사카 호텔 추천해줘' },
    ],
  },
};

/** 캐시 히트일 때만 이게 바로 나온다. 미스면 콜백으로 온다. */
export const SKILL_RESPONSE_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        listCard: {
          header: { title: '오사카 호텔 추천 5곳' },
          items: [
            {
              title: '호텔 한큐 리스파이어 오사카',
              description: '1박 172,000원~ · 평점 9.1 · 우메다',
              imageUrl: 'https://picsum.photos/seed/osaka-005/800/400',
              link: { web: 'https://bot.nolmoa.com/r/6kCgoISYegpS' },
            },
          ],
          buttons: [
            { label: '다른 도시 보기', action: 'message', messageText: '호텔 추천해줘' },
          ],
        },
      },
    ],
    quickReplies: [
      { label: '도쿄 호텔', action: 'message', messageText: '도쿄 호텔 추천해줘' },
    ],
  },
};

/**
 * 스웨거 예시.
 *
 * 진짜 페이로드/응답이어야 한다 — 여기 있는 걸 그대로 붙여 넣어 Execute 했을 때
 * 동작하지 않으면 예시가 아니라 거짓말이다. (그걸 지키는 게 swagger-examples.spec.ts)
 */

/** 오픈빌더 폴백 블록이 보내는 페이로드. 엔티티가 없으므로 params 는 늘 비어 있다. */
export const ROUTER_REQUEST_EXAMPLE = {
  intent: { id: 'intent-1', name: '폴백 블록' },
  userRequest: {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: '6a90f3a995f722d77d9fd0e6', name: '폴백 블록' },
    utterance: '@여행메이트 오사카 호텔 4명 9월 22~24일 추천해줘',
    lang: 'kr',
    user: { id: 'u1', type: 'botUserKey', properties: { botUserKey: 'u1' } },
  },
  bot: { id: '6a90f3a995f722d77d9fd0e6', name: '여행메이트 TST' },
  action: { name: '폴백액션', clientExtra: {}, params: {}, detailParams: {}, id: 'action-1' },
};

/** 콜백을 켠 블록만 callbackUrl 을 실어 보낸다. 그 존재가 곧 "콜백을 써도 된다" 다. */
export const ROUTER_REQUEST_WITH_CALLBACK_EXAMPLE = {
  ...ROUTER_REQUEST_EXAMPLE,
  userRequest: {
    ...ROUTER_REQUEST_EXAMPLE.userRequest,
    callbackUrl: 'https://bot-api.kakao.com/v1/bots/xxx/callback/yyy',
  },
};

/** "더 보기" 버튼이 보내는 페이로드. **clientExtra 가 커서를 들고 온다.** */
export const MORE_REQUEST_EXAMPLE = {
  ...ROUTER_REQUEST_EXAMPLE,
  userRequest: { ...ROUTER_REQUEST_EXAMPLE.userRequest, utterance: '오사카 호텔 더 보기' },
  action: {
    ...ROUTER_REQUEST_EXAMPLE.action,
    clientExtra: { cache_key: 'hotel:12', offset: 5 },
  },
};

/** 여행과 무관하거나 의도를 못 잡았을 때. **오류 문구를 쓰지 않는다.** */
export const HELP_RESPONSE_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        listCard: {
          header: { title: '여행메이트가 도와드릴 수 있는 것' },
          items: [
            { title: '🏨 호텔 찾기', description: '오사카 호텔 추천해줘' },
            { title: '✈️ 항공권 찾기', description: '오사카 항공권 찾아줘' },
            { title: '📍 관광지·맛집', description: '오사카 관광지 추천해줘' },
          ],
        },
      },
    ],
    quickReplies: [
      { label: '오사카 호텔', action: 'message', messageText: '오사카 호텔 추천해줘' },
      { label: '오사카 항공권', action: 'message', messageText: '오사카 항공권 찾아줘' },
      { label: '오사카 관광지', action: 'message', messageText: '오사카 관광지 추천해줘' },
    ],
  },
};

/** 저장된 결과가 있을 때. 카드 + 고지 말풍선 + 더보기 버튼. */
export const CARD_RESPONSE_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        listCard: {
          header: { title: '오사카 호텔 5곳' },
          items: [
            {
              title: '호텔 그란비아 오사카',
              description: '1박 145,000원~ · 평점 8.7 · 우메다',
              link: { web: 'https://bot.nolmoa.com/r/Ab3xY9zQ1mKd' },
            },
          ],
          buttons: [
            {
              label: '더 보기',
              action: 'block',
              blockId: '6a90f3a995f722d77d9fd0e6',
              messageText: '오사카 호텔 더 보기',
              extra: { cache_key: 'hotel:12', offset: 5 },
            },
          ],
        },
      },
      {
        simpleText: {
          text:
            'AI가 정리한 참고 정보예요. 가격은 실제와 다를 수 있어요.\n' +
            '날짜·인원(4명, 9월 22~24일)은 반영되지 않았어요.',
        },
      },
    ],
    quickReplies: [
      { label: '도쿄 호텔', action: 'message', messageText: '도쿄 호텔 추천해줘' },
      { label: '후쿠오카 호텔', action: 'message', messageText: '후쿠오카 호텔 추천해줘' },
    ],
  },
};

/** 캐시 미스 + 콜백 켜짐. 5초 안에 이걸 주고, 결과는 callbackUrl 로 민다. */
export const CALLBACK_ACK_EXAMPLE = {
  version: '2.0',
  useCallback: true,
  data: { text: '오사카 호텔을 찾고 있어요. 잠시만요 🔍' },
};

/** 캐시 미스 + 콜백 꺼짐. 스웨거에서 Execute 하면 보통 이게 나온다. */
export const SEARCH_STARTED_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      { simpleText: { text: '오사카 호텔을 찾고 있어요 🔍\n30초쯤 뒤에 다시 물어봐 주세요!' } },
    ],
  },
};

/** 다른 사람이 먼저 같은 걸 물어 검색이 돌고 있을 때. AI 를 두 번 부르지 않는다. */
export const BUSY_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      { simpleText: { text: '오사카 호텔을 먼저 찾고 있어요 🔍\n잠시 뒤 다시 물어봐 주세요!' } },
    ],
  },
};

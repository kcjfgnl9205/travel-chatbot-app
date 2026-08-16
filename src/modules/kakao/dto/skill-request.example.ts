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

/** 스킬 응답 예시 (listCard 한 장). */
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

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
    // 오픈빌더 커스텀 엔티티 `여행도시` 가 매칭되면 이 모양으로 온다.
    // origin 은 사용자가 친 말 그대로, value 는 엔티티 대표값이다 — 서버는 value 를 쓴다.
    // 비어 있어도 도시 사전 → 모델 순으로 발화에서 폴백 파싱한다.
    params: { 여행도시: '오사카' },
    detailParams: {
      여행도시: { origin: '오사카', value: '오사카', groupName: '' },
    },
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

// ------------------------------------------------------------------ 항공권
/** 오픈빌더 [항공권검색] 블록이 보내는 요청. */
export const FLIGHT_REQUEST_EXAMPLE = {
  intent: { id: 'intent-2', name: '항공권검색' },
  userRequest: {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: 'block-2', name: '항공권검색' },
    utterance: '다음달 3일에 오사카 왕복 항공권 2명 찾아줘',
    lang: 'kr',
    user: {
      id: 'swagger-test',
      type: 'accountId',
      properties: { botUserKey: 'swagger-test' },
    },
  },
  bot: { id: 'bot-1', name: '여행봇' },
  action: {
    id: 'action-2',
    name: '항공권검색액션',
    // 지금 블록에 붙어 있는 엔티티는 `여행도시`(도착지) 하나다.
    // 출발지는 태깅돼 있지 않아 발화에서 파싱하고, 못 찾으면 서울(ICN) 출발로 본다.
    // 날짜도 엔티티가 없어 모델이 "다음달 3일" 을 절대 날짜로 바꾼다.
    params: { 여행도시: '오사카' },
    detailParams: {
      여행도시: { origin: '오사카', value: '오사카', groupName: '' },
    },
    clientExtra: {},
  },
};

export const FLIGHT_REQUEST_WITH_CALLBACK_EXAMPLE = {
  ...FLIGHT_REQUEST_EXAMPLE,
  userRequest: {
    ...FLIGHT_REQUEST_EXAMPLE.userRequest,
    callbackUrl: 'https://bot-api.kakao.com/v1/bots/xxx/callback/yyy',
  },
};

/** 캐시 미스 + 콜백 켜짐. **첫 요청의 기본 응답이다.** */
export const FLIGHT_CALLBACK_ACK_EXAMPLE = {
  version: '2.0',
  useCallback: true,
  data: { text: '서울→오사카 항공권을 찾고 있어요. 잠시만요 ✈️' },
};

/** 캐시 미스 + 콜백 꺼짐. 검색은 백그라운드로 돌고, 다시 물으면 카드가 나온다. */
export const FLIGHT_SEARCH_STARTED_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        simpleText: {
          text: '서울→오사카 항공권을 찾고 있어요 ✈️\n30초쯤 뒤에 다시 물어봐 주세요!',
        },
      },
    ],
    quickReplies: [
      { label: '도쿄 항공권', action: 'message', messageText: '도쿄 항공권 찾아줘' },
    ],
  },
};

/** 노선을 못 알아들었을 때. */
export const ASK_ROUTE_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        simpleText: {
          text: '어디로 가는 항공권을 찾으세요?\n예) 다음달 3일 오사카 왕복 항공권 2명',
        },
      },
    ],
    quickReplies: [
      { label: '오사카 항공권', action: 'message', messageText: '오사카 항공권 찾아줘' },
    ],
  },
};

/**
 * 캐시 히트일 때만 이게 바로 나온다. 미스면 콜백으로 온다.
 *
 * 호텔은 listCard 인데 항공권은 **itemCard 캐러셀**이다. 한 줄 40자에
 * 항공사·편명·시각·소요·경유·가격이 안 들어가기 때문이다.
 * 캐러셀에는 header 자리가 없어서 공통 맥락(노선·조건·가격 주의)은 앞 말풍선이 진다.
 */
export const FLIGHT_RESPONSE_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        simpleText: {
          text:
            '서울→오사카 왕복 항공권 2편이에요 ✈️\n가는 날 10/3(토) · 오는 날 10/6(화) · 2명\n' +
            '서울 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.\n' +
            '가격은 검색 시점 기준이라 실제 예약가와 다를 수 있어요.',
        },
      },
      {
        carousel: {
          type: 'itemCard',
          items: [
            {
              head: { title: '서울 → 오사카 · 10/3(토)' },
              itemList: [
                { title: '항공사', description: '대한항공 KE723' },
                { title: '가는편', description: '10/3(토) 09:20→11:00' },
                { title: '오는편', description: '10/6(화) 12:30→14:20' },
                { title: '소요', description: '1시간 40분 · 직항' },
              ],
              itemListAlignment: 'right',
              itemListSummary: { title: '예상가', description: '1인 289,000원' },
              buttons: [
                {
                  action: 'webLink',
                  label: '예약 페이지 보기',
                  webLinkUrl: 'https://bot.nolmoa.com/r/Ab3xY9kQ2mZp',
                },
              ],
              buttonLayout: 'vertical',
            },
            {
              head: { title: '서울 → 오사카 · 10/3(토)' },
              itemList: [
                { title: '항공사', description: '피치항공 MM028' },
                { title: '가는편', description: '10/3(토) 08:05→09:45' },
                { title: '오는편', description: '10/6(화) 10:30→12:25' },
                { title: '소요', description: '1시간 40분 · 직항' },
              ],
              itemListAlignment: 'right',
              itemListSummary: { title: '예상가', description: '1인 148,000원' },
              buttons: [
                {
                  action: 'webLink',
                  label: '예약 페이지 보기',
                  webLinkUrl: 'https://bot.nolmoa.com/r/9pQmZk2Yx3bA',
                },
              ],
              buttonLayout: 'vertical',
            },
          ],
        },
      },
    ],
    quickReplies: [
      { label: '도쿄 항공권', action: 'message', messageText: '도쿄 항공권 찾아줘' },
    ],
  },
};

// ------------------------------------------------------------------ 관광지
/** 오픈빌더 [관광지추천] 블록이 보내는 요청. */
export const ATTRACTION_REQUEST_EXAMPLE = {
  intent: { id: 'intent-3', name: '관광지추천' },
  userRequest: {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: 'block-3', name: '관광지추천' },
    utterance: '오사카 관광지 추천해줘',
    lang: 'kr',
    user: {
      id: 'swagger-test',
      type: 'accountId',
      properties: { botUserKey: 'swagger-test' },
    },
  },
  bot: { id: 'bot-1', name: '여행봇' },
  action: {
    id: 'action-3',
    name: '관광지추천액션',
    // 호텔·항공권과 같은 `여행도시` 엔티티를 쓴다. 세 블록의 도시 추출이 동일하다.
    params: { 여행도시: '오사카' },
    detailParams: {
      여행도시: { origin: '오사카', value: '오사카', groupName: '' },
    },
    clientExtra: {},
  },
};

export const ATTRACTION_REQUEST_WITH_CALLBACK_EXAMPLE = {
  ...ATTRACTION_REQUEST_EXAMPLE,
  userRequest: {
    ...ATTRACTION_REQUEST_EXAMPLE.userRequest,
    callbackUrl: 'https://bot-api.kakao.com/v1/bots/xxx/callback/yyy',
  },
};

/** 캐시 미스 + 콜백 켜짐. **첫 요청의 기본 응답이다.** */
export const ATTRACTION_CALLBACK_ACK_EXAMPLE = {
  version: '2.0',
  useCallback: true,
  data: { text: '오사카 관광지를 찾고 있어요. 잠시만요 🗺️' },
};

/** 캐시 미스 + 콜백 꺼짐. 검색은 백그라운드로 돌고, 다시 물으면 카드가 나온다. */
export const ATTRACTION_SEARCH_STARTED_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      { simpleText: { text: '오사카 관광지를 찾고 있어요 🗺️\n30초쯤 뒤에 다시 물어봐 주세요!' } },
    ],
    quickReplies: [
      { label: '도쿄 관광지', action: 'message', messageText: '도쿄 관광지 추천해줘' },
    ],
  },
};

/** 도시를 못 알아들었을 때. */
export const ASK_ATTRACTION_CITY_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      { simpleText: { text: '어느 도시 관광지를 찾으세요?\n예) 오사카 관광지 추천해줘' } },
    ],
    quickReplies: [
      { label: '오사카 관광지', action: 'message', messageText: '오사카 관광지 추천해줘' },
    ],
  },
};

/**
 * 캐시 히트일 때만 이게 바로 나온다. 미스면 콜백으로 온다.
 *
 * 호텔과 같은 listCard 지만 **줄 링크의 목적지가 다르다** — 호텔은 애드픽 커미션
 * 링크로, 관광지는 구글맵으로 간다. 둘 다 `/r/{clickId}` 를 먼저 거치므로
 * 카드 JSON 만 봐서는 구분되지 않는다 (그게 의도다 — 추적 경로가 하나뿐이다).
 *
 * 이미지가 없다. 관광지는 긁어올 예약 페이지가 없어서 썸네일 출처가 없다.
 */
export const ATTRACTION_RESPONSE_EXAMPLE = {
  version: '2.0',
  template: {
    outputs: [
      {
        listCard: {
          header: { title: '오사카 관광지 5곳' },
          items: [
            {
              title: '오사카성',
              description: '약 6,000원 · 2시간 · 주오구',
              link: { web: 'https://bot.nolmoa.com/r/6kCgoISYegpS' },
            },
            {
              title: '도톤보리',
              description: '무료 · 2시간 · 난바',
              link: { web: 'https://bot.nolmoa.com/r/Ab3xY9kQ2mZp' },
            },
          ],
          buttons: [
            { label: '다른 도시 보기', action: 'message', messageText: '관광지 추천해줘' },
          ],
        },
      },
    ],
    quickReplies: [
      { label: '도쿄 관광지', action: 'message', messageText: '도쿄 관광지 추천해줘' },
    ],
  },
};

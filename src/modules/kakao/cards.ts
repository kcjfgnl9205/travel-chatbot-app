/**
 * 사용자가 실제로 읽는 문구.
 *
 * [templates.ts](./templates.ts) 가 "카카오 JSON 을 어떻게 만드는가" 라면 여기는
 * **"무엇을 말하는가"** 다. 문구를 도메인 서비스마다 흩어두면 같은 상황에서 방마다
 * 다른 말이 나가고, 고지 문구처럼 빠지면 안 되는 줄이 조용히 사라진다.
 */

import * as t from './templates';
import { RouteProblem } from '../flight/airports';
import {
  MAX_ADULTS as FLIGHT_MAX_ADULTS,
  ResolvedTrip,
  TripDateProblem,
  TripParams,
  resolveTrip,
} from '../flight/search-url';
import {
  MAX_ADULTS as HOTEL_MAX_ADULTS,
  ResolvedStay,
  StayDateProblem,
  resolveStay,
  stayOf,
} from '../hotel/search-url';
import { CityChoice } from '../places/places.types';
import { SearchKind, SearchMeta } from '../search/search.types';

/**
 * 목적격 조사를 붙인다. `관광지` → `관광지를`, `호텔` → `호텔을`.
 *
 * ⚠️ 문구를 `${...}을` 로 박아두면 **"관광지을 찾으세요?"** 가 나간다. 실제로 나갔다.
 *    한글 음절은 (코드 - 0xAC00) % 28 이 0 이 아니면 받침이 있다. 한글이 아니면
 *    (영문·숫자로 끝나는 지명) 받침이 없는 것으로 본다 — "오사카 Hotel를" 보다는 낫다.
 */
export function withObjectParticle(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  const isHangulSyllable = code >= 0xac00 && code <= 0xd7a3;
  const hasFinalConsonant = isHangulSyllable && (code - 0xac00) % 28 !== 0;
  return `${word}${hasFinalConsonant ? '을' : '를'}`;
}

/**
 * "이 나라의 어느 도시냐" 를 묻는 말. **도메인마다 다르게 묻는다.**
 *
 * 「일본 어느 도시의 항공권을 찾을까요?」는 틀린 말은 아니지만, 묻는 사람은
 * 항공권을 고르는 게 아니라 **갈 곳**을 고르는 중이다. 하는 일에 맞춰 물어야
 * 도시 이름이 바로 떠오른다.
 */
export const CITY_QUESTION: Record<SearchKind, (country: string) => string> = {
  hotel: (c) => `${c}의 어느 도시에서 머무르시나요?`,
  flight: (c) => `${c}의 어느 도시로 가시나요?`,
  attraction: (c) => `${c}의 어느 도시를 찾으세요?`,
};

/**
 * 글에서 멘션 버튼을 가리키는 말.
 *
 * ⚠️ **버튼 라벨과 똑같이 적어야 한다.** 버튼에 박히는 글자는 `@봇이름` 이고, 봇 이름을
 *    모를 때는 「챗봇 멘션하기」다([templates.ts](./templates.ts) `mentionButton`).
 *    글에만 「@가자고」라고 적어두면 그런 버튼이 없는 화면에서 찾다가 대화가 끊긴다.
 */
function mentionButtonText(botName: string | null): string {
  const name = botName?.trim();
  return name ? `아래 @${name} 버튼` : '아래 버튼';
}

/**
 * 나라도 모를 때 묻는 말. **도메인마다 다르게 묻는다.**
 *
 * 항공권은 「어느 도시의 항공권」이 아니라 **어디로 가는지**를 묻는다. 고르는 것이
 * 항공권이 아니라 목적지라서, 그렇게 물어야 도시 이름이 바로 떠오른다.
 */
const PLACE_QUESTION: Record<SearchKind, string> = {
  hotel: '어느 도시의 호텔을 찾으세요?',
  flight: '어느 도시로 가는 항공권을 찾으세요?',
  attraction: '어느 도시의 관광지를 찾으세요?',
};

/** 되묻기를 짧게 갈 때 붙이는 한 줄. 항공권은 출발지와 헷갈리지 않게 못 박는다. */
const CITY_NAME_PROMPT: Record<SearchKind, string> = {
  hotel: '도시 이름을 말씀해 주세요.',
  flight: '도착할 도시 이름을 말씀해 주세요.',
  attraction: '도시 이름을 말씀해 주세요.',
};

export const KIND_LABEL: Record<SearchKind, string> = {
  hotel: '호텔',
  flight: '항공권',
  attraction: '관광지',
};

/**
 * 예문에 쓰는 **예시** 지역.
 *
 * 허용 목록이 아니다. 여기 없는 지역도 전부 검색된다 — "이런 걸 물어보면 된다"를
 * 보여주는 용도일 뿐이다.
 *
 * ⚠️ 예전에는 이걸로 퀵리플라이를 만들어 모든 카드에 달았는데, **팀채팅 챗봇은
 *    QuickReplies 를 지원하지 않는다**(그룹 챗봇 beta 가이드 표 3). 단톡방에서는
 *    아무것도 안 보였고, 누를 게 없으니 되묻기에서 대화가 그대로 끊겼다.
 *    지금은 멘션 버튼([templates.ts](./templates.ts) mentionCard)이 그 자리에 있다.
 */
export const EXAMPLE_PLACE = '오사카';

/** '오사카 호텔 추천해줘' 처럼 그대로 다시 보낼 수 있는 문장. */
export function exampleUtterance(place: string, kind: SearchKind): string {
  if (kind === 'flight') return `${place} 항공권 찾아줘`;
  return `${place} ${KIND_LABEL[kind]} 추천해줘`;
}

/**
 * 발화를 못 알아들었을 때.
 *
 * ⚠️ **"잘못된 검색입니다" 같은 오류 문구를 쓰지 않는다.** 봇을 멘션한 인사말·잡담까지
 *    여기로 온다. 못 알아들었다는 말은 하되 탓하지 않고, 다음에 누를 것을 준다.
 *
 * textCard 로 보낸다 — listCard 의 header 는 제목만 보여주고(description 은 무시된다)
 * 안내 문구를 넣을 자리가 없다. 예시는 카드에 늘어놓지 않고, 챗봇 설정에 등록한
 * 도움말을 여는 `guide` 버튼 뒤로 뺀다.
 */
export function notUnderstoodCard(botName: string | null): t.Json {
  return t.skillResponse([
    t.textCard({
      title: '어떤 여행 정보를 찾으세요?',
      // ⚠️ **사용자 탓으로 읽히면 안 된다.** 이 분기에는 못 알아들은 발화뿐 아니라
      //    **서버 오류도 떨어진다.** 「정확히 이해하지 못했어요」는 우리가 고장 난
      //    경우에도 사용자가 자기 문장을 의심하게 만든다 — 그 사람은 같은 말을
      //    바꿔 치며 헤매고, 바꿔도 결과는 같다.
      description: '지금은 요청하신 내용을 안내해 드리지 못했어요.\n도시 이름과 찾으시는 항목을 함께 말씀해 주세요.',
      buttons: [t.guideButton()],
    }),
    t.mentionCard(botName),
  ]);
}

/**
 * **예산을 넘겼는데 콜백도 없을 때.**
 *
 * 예전에는 이 자리에 `notUnderstoodCard` 가 나갔다. 그게 틀린 말이었다 — 못 알아들은
 * 게 아니라 **제때 못 끝낸 것**이고, 사용자는 "어떤 여행을 찾으시나요?" 를 보고
 * 자기 문장이 잘못된 줄 알아 같은 말을 다르게 바꿔 치며 헤맸다. 실제로 "부산 관광지
 * 추천해줘" 가 이 카드를 받았고, "부산 관광지" 로 줄여 치니 결과가 나왔다 — 짧아서가
 * 아니라 그 사이 백그라운드 작업이 끝나 캐시가 따뜻해졌기 때문이다.
 *
 * ⚠️ **콜백이 켜져 있으면 여기 오지 않는다.** 그때는 늦은 답을 콜백으로 밀어준다
 *    ([router.controller.ts](./router.controller.ts) `pushWhenReady`).
 */
export function slowText(botName: string | null): t.Json {
  return t.simpleTextWithMention(
    '아직 정리 중이에요.\n잠시 뒤 같은 질문을 다시 말씀해 주시면 바로 보여드릴게요.',
    botName,
  );
}

/**
 * 도움말 카드. 할 수 있는 세 가지를 예시와 함께 보여준다.
 *
 * 저장된 결과가 만료된 "더 보기" 에서 쓴다. 못 알아들었을 때는 [notUnderstoodCard] 가
 * 나가고, 거기서는 챗봇 설정의 도움말(`guide` 버튼)을 연다.
 *
 * 줄을 누르면 예시 문장이 그대로 전송된다 — 보고 따라 치는 대신 눌러서 바로 써본다.
 */
export function helpCard(botName: string | null): t.Json {
  return t.listCard(
    {
      headerTitle: '가자고에게 이렇게 물어보세요',
      items: [
        t.listItem({ title: '🏨 호텔 찾기', description: '오사카 호텔 추천해줘', messageText: '오사카 호텔 추천해줘' }),
        t.listItem({ title: '✈️ 항공권 찾기', description: '오사카 항공권 찾아줘', messageText: '오사카 항공권 찾아줘' }),
        t.listItem({ title: '📍 관광지·맛집', description: '오사카 관광지 추천해줘', messageText: '오사카 관광지 추천해줘' }),
      ],
    },
    botName,
  );
}

/**
 * 나라를 말했을 때. **그 나라의 도시로 되묻는다.**
 *
 * ⚠️ 나라 단위로 검색하면 결과가 뭉개진다 — "베트남 호텔" 의 답은 다낭·하노이·호치민이
 *    섞인 목록이고, 그건 아무에게도 쓸모가 없다. 대신 한 번 더 물어보는 게 맞다.
 *
 * ⚠️ **예시 도시를 보여주면 안 된다.** 예전에는 베트남을 물어도 오사카·도쿄·후쿠오카를
 *    권했다. 물어본 나라와 무관한 답은 되묻기가 아니라 딴소리다.
 */
export function askCityInCountry(
  kind: SearchKind,
  country: string,
  cities: CityChoice[],
  origin: string,
  botName: string | null,
): t.Json {
  // 도시를 못 구했으면(모델 실패) 일반 되묻기로 떨어진다 — 예시라도 주는 게 낫다.
  if (!cities.length) return askPlaceCard(kind, botName);

  // ⚠️ **줄을 누르면 완성된 문장이 그대로 전송된다.** message 버튼은 누르는 즉시
  //    전송되는데, 이 자리에서는 그게 정확히 원하는 동작이다 — 도시와 의도를 모두
  //    박아두면 그 발화가 라우터로 돌아와 평소 경로를 탄다.
  //
  //    단톡방에서는 봇을 멘션한 메시지만 서버로 온다. 사용자가 도시 이름을 직접 치면
  //    멘션이 빠져 **봇이 아예 듣지 못한다** — 눌러서 보내는 길이 있어야 하는 이유다.
  const card: t.Json = {
    listCard: {
      header: { title: t.cut(CITY_QUESTION[kind](country), t.MAX_LIST_HEADER_TITLE) },
      items: cities.slice(0, t.MAX_LIST_ITEMS).map((city) => ({
        title: t.cut(city.name, t.MAX_LIST_ITEM_TITLE),
        // 처음 가는 사람은 도시 이름만 보고 못 고른다. "신주쿠 · 시부야" 한 줄이면 고른다.
        ...(city.blurb ? { description: t.cut(city.blurb, t.MAX_LIST_ITEM_DESC) } : {}),
        action: 'message',
        messageText: pickUtterance(city.name, kind, origin),
      })),
    },
  };

  // 목록에 없는 도시를 가려는 사람의 몫. 카드 안 버튼으로 두면 다섯 번째 선택지처럼
  // 보이는데, 이건 선택지가 아니라 다른 길이다.
  return t.skillResponse([card, otherCityCard(kind, country, origin, botName)]);
}

/**
 * "다른 도시" 안내. **멘션 버튼이 달린 카드다.**
 *
 * 예전에는 버튼 없이 글로만 "「@가자고 삿포로 호텔 추천해줘」처럼 보내주세요" 라고
 * 적었다. 입력창을 채워주는 액션이 문서에 없다고 봤기 때문인데, 사실은 있었다 —
 * 그룹 챗봇 beta 가이드의 봇 응답 버튼 플러그인 `mention` 이다. 당시 짐작으로 쓴
 * `talk_mention` 은 없는 값이라 **응답 전체가 렌더링되지 않았다.**
 *
 * ⚠️ 버튼이 넣어주는 건 **멘션까지**다. 그래서 예문은 여전히 필요하다 — 다만 이제
 *    예문에서 `@봇이름` 을 뺀다. 버튼이 넣어줄 것을 사람에게 또 치게 하면 두 번 들어간다.
 */
function otherCityCard(
  kind: SearchKind,
  country: string,
  origin: string,
  botName: string | null,
): t.Json {
  const example = pickUtterance(otherCityExample(country), kind, origin);

  return t.textCard({
    description:
      `찾으시는 도시가 없나요?\n` +
      `${mentionButtonText(botName)}을 누르고 ‘${example}’처럼 말씀해 주세요.`,
    buttons: [t.mentionButton(botName)],
  });
}

/**
 * 줄을 눌렀을 때 전송될 문장.
 *
 * 항공권은 **출발지까지 박는다.** 그러면 카드 아래 출발지 추측 고지가 필요 없어지고,
 * 부산에서 가려는 사람은 그 문장을 고쳐 보내면 된다.
 */
function pickUtterance(city: string, kind: SearchKind, origin: string): string {
  if (kind === 'flight') return flightExample(city, origin);
  return exampleUtterance(city, kind);
}

/**
 * 항공권 예문. **출발지를 빼지 않는다.**
 *
 * 「오사카 항공권 찾아줘」로 보내면 서울 출발로 굳는데, 예문이 그 꼴이면 다른 데서
 * 출발하는 사람은 **고쳐 말할 꼴을 끝내 못 본다.** 「찾아줘」는 뺐다 — 없어도
 * '항공권' 이 여행 신호(TRAVEL_HINT)라 그대로 보내면 통한다.
 */
function flightExample(dest: string, origin: string): string {
  return `${origin}에서 ${dest} 항공권`;
}

/** 「다른 곳에서 출발하시면」 예문에 쓸 출발지. 도착지와 같으면 딴 데를 든다. */
function otherOrigin(dest: string): string {
  return dest === '부산' ? '제주' : '부산';
}

/**
 * 안내 문구에 쓸 "목록에 없는 도시" 예시.
 *
 * 나라와 상관없는 도시를 예로 들면(베트남을 묻는 사람에게 "삿포로") 안내가 아니라
 * 딴소리가 된다. 사전에 있는 그 나라 도시 하나를 고르고, 없으면 도시를 빼고 말한다.
 */
function otherCityExample(country: string): string {
  return OTHER_CITY_EXAMPLE[country] ?? NO_CITY_EXAMPLE;
}

/** 사전에 없는 나라. 도시를 지어내느니 도시를 빼고 말한다. */
const NO_CITY_EXAMPLE = '그 도시';

/**
 * 나라별 **출발지 예시 도시.** 공항이 있고 사전에 있는 대표 도시로 고른다
 * ([city-table.ts](../places/city-table.ts)).
 *
 * ⚠️ `OTHER_CITY_EXAMPLE` 과 다른 목록이다. 저건 「대표 4곳에 없는 도시」를 찾는
 *    사람에게 드는 예시고, 여기는 **그 나라에서 비행기가 뜨는 곳**이어야 한다.
 */
const COUNTRY_DEPARTURE_EXAMPLE: Record<string, string> = {
  일본: '도쿄',
  베트남: '하노이',
  태국: '방콕',
  중국: '베이징',
  대만: '타이베이',
  필리핀: '마닐라',
  미국: '뉴욕',
  프랑스: '파리',
  이탈리아: '로마',
  스페인: '마드리드',
  독일: '베를린',
};

/** 되묻기 예문. 항공권은 기본 출발지를 넣어 그대로 보내도 통하게 만든다. */
function askExample(city: string, kind: SearchKind): string {
  return kind === 'flight' ? flightExample(city, '서울') : exampleUtterance(city, kind);
}

/** 나라별 "목록에 없는" 예시 도시. 대표 4곳에 안 들어가는 곳으로 고른다. */
const OTHER_CITY_EXAMPLE: Record<string, string> = {
  일본: '삿포로',
  베트남: '하롱베이',
  태국: '치앙마이',
  중국: '시안',
  대만: '가오슝',
  필리핀: '보홀',
  미국: '시애틀',
  프랑스: '니스',
  이탈리아: '피렌체',
  스페인: '세비야',
  독일: '함부르크',
};

/**
 * "다른 도시" 를 누른 사람에게. **다음 발화를 지명으로 받겠다는 약속이다.**
 *
 * ⚠️ 버튼이 문장까지 넣어주지는 못한다. 멘션 버튼은 입력창에 `@봇이름` 까지만
 *    넣으므로 도시 이름은 사용자가 친다. 그래서 봇이 한 번 되묻고, 서버가
 *    **그 사람의 다음 발화**를 지명으로 해석한다 ([pending.ts](./pending.ts)).
 */
export function askPlaceNameOnly(
  kind: SearchKind,
  country: string | null,
  botName: string | null,
  opts: { again?: boolean } = {},
): t.Json {
  const generic = PLACE_QUESTION[kind];

  // ⚠️ **두 번째 되묻기에는 예문을 다시 깔지 않는다.** 나라를 또 말한 사람은 첫 되묻기에서
  //    같은 안내를 이미 봤다. 토씨 하나 안 틀리고 반복하면 봇이 자기 말을 못 들은 줄 안다 —
  //    물어야 할 것 하나만 남기는 쪽이 무엇을 치면 되는지가 더 선명하다.
  if (opts.again) {
    return t.simpleTextWithMention(`${generic}\n${CITY_NAME_PROMPT[kind]}`, botName);
  }

  const where = country ? CITY_QUESTION[kind](country) : generic;

  // ⚠️ **예시 도시는 그 나라에서 고른다.** 예전에는 나라와 상관없이 「예) 다낭」이 고정으로
  //    붙어서, 태국·일본을 묻는 사람에게 베트남 도시를 권했다 — 되묻기가 아니라 딴소리다.
  //
  // ⚠️ **예문에 `@봇이름` 을 넣지 않는다.** 멘션은 버튼이 넣어준다. 글에도 적어두면
  //    버튼을 누른 사람 입력창에 멘션이 두 번 들어간다.
  const city = country ? otherCityExample(country) : null;
  const how =
    city && city !== NO_CITY_EXAMPLE
      ? `${mentionButtonText(botName)}을 누르고 ‘${askExample(city, kind)}’처럼 ` +
        '도시 이름을 함께 말씀해 주세요.'
      : `${mentionButtonText(botName)}을 누르고 도시 이름을 말씀해 주세요.`;

  return t.simpleTextWithMention(`${where}\n${how}`, botName);
}

/** 무엇을 묻는지는 알겠는데 지역이 없다. 되묻되 예시로 답을 쉽게 만든다. */
export function askPlaceCard(kind: SearchKind, botName: string | null): t.Json {
  const example =
    kind === 'flight'
      ? flightExample(EXAMPLE_PLACE, otherOrigin(EXAMPLE_PLACE))
      : exampleUtterance(EXAMPLE_PLACE, kind);
  return t.simpleTextWithMention(
    `${PLACE_QUESTION[kind]}\n` +
      `${mentionButtonText(botName)}을 누르고 ‘${example}’처럼 말씀해 주세요.`,
    botName,
  );
}

/**
 * **날짜가 잘못됐을 때 되묻는다. 멋대로 고치지 않는다.**
 *
 * 예전에는 조용히 고쳤다 — "11월 23일 출발 11월 20일 귀국" 에 **11월 30일 귀국**으로
 * 검색된다고 안내했고(출발일 + 7일), 사용자는 자기가 말한 적 없는 날짜의 링크를 받았다.
 * 연도도 마찬가지로 2026년을 적었는데 2027년으로 나갔다.
 *
 * ⚠️ **카카오에는 날짜 선택 버튼이 없다.** 버튼 action 은 `webLink`·`message`·`block`·
 *    `phone`·`share`·`operator` 가 전부이고 달력 입력은 없다. 게다가 팀채팅 챗봇은
 *    QuickReplies 도 못 쓴다. 그래서 **후보 날짜를 message 버튼으로 내놓는 것이
 *    유일한 길**이다 — 누르면 고쳐진 문장이 그대로 전송돼 평소 경로를 탄다.
 *
 * ⚠️ **고친 날짜를 우리가 고르지만, 적용은 사용자가 누를 때다.** 그게 요청의 핵심이다
 *    ("사용자가 날짜를 수정하거나 변경에 동의한 뒤에 링크를 제공").
 */
export function fixDatesCard(
  meta: SearchMeta,
  trip: TripParams,
  botName: string | null,
): t.Json {
  // 부르는 쪽이 problem 을 보고 이 카드를 골랐다. 여기까지 왔는데 없으면 버그다.
  const problem = trip.problem!;
  const oneway = meta.tripType === 'ow';
  const say = (depart: string, back: string | null): string =>
    [
      `${meta.fromName ?? '서울'}에서 ${meta.placeName} 항공권`,
      `${fullDayText(depart)} 출발`,
      oneway || !back ? '편도' : `${fullDayText(back)} 귀국`,
    ].join(' ');

  // ⚠️ **이유는 헤더가 아니라 말풍선에 쓴다.** 리스트 카드 헤더는 카카오가 **한 줄**만
  //    보여주고 넘치면 「…」로 자른다. 「귀국일(11월 20일)이 출발일(11월 23일)보다
  //    빨라요」는 핵심인 뒤쪽 날짜와 '빨라요' 가 잘려서, 무엇이 틀렸는지가 안 보였다.
  //    말풍선은 줄바꿈되므로 이유를 온전히 싣고, 헤더는 할 일만 짧게 적는다.
  // ⚠️ **연도를 적는다.** 12월에 「1월 5일」만 보면 올해인지 내년인지 모른다 — 지난
  //    날짜라고 되묻는 자리에서 연도를 빼면 무엇이 지났다는 건지가 안 보인다.
  const reason =
    problem.kind === 'past'
      ? `${fullDayText(problem.date)}은 이미 지난 날짜예요.\n아래에서 새로운 여행 날짜를 선택해 주세요.`
      : `귀국일(${fullDayText(problem.back)})이 출발일(${fullDayText(problem.depart)})보다 빨라요.\n` +
        '아래에서 여행 날짜를 다시 선택해 주세요.';
  const header = '여행 날짜를 확인해 주세요';

  // ⚠️ **예문에는 연도를 안 쓴다.** 버튼(messageText)과 달리 이건 한 해가 지나도
  //    그대로 남는 글이라, 연도를 박으면 지난 날짜를 예문으로 권하게 된다. 연도가
  //    없으면 파서가 다음 해로 굴려서 **항상 미래 날짜**가 된다.
  const example = [
    `${meta.fromName ?? '서울'}에서 ${meta.placeName} 항공권`,
    '12월 1일 출발',
    oneway ? '편도' : '12월 5일 귀국',
  ].join(' ');

  const items = choicesFor(problem, trip).map((choice) => ({
    title: t.cut(choice.label, t.MAX_LIST_ITEM_TITLE),
    description: t.cut('이 일정으로 링크 보기', t.MAX_LIST_ITEM_DESC),
    action: 'message',
    messageText: say(choice.depart, choice.back),
  }));

  return t.skillResponse([
    { simpleText: { text: reason } },
    {
      listCard: {
        header: { title: t.cut(header, t.MAX_LIST_HEADER_TITLE) },
        items: items.slice(0, t.MAX_LIST_ITEMS),
      },
    },
    t.textCard({
      // ⚠️ **예문은 그 자체로 통하는 문장이어야 한다.** 처음에는 날짜만 적어
      //    「11월 20일 출발 11월 23일 귀국」이라고 안내했는데, 그 문장에는 여행
      //    신호가 없어서(TRAVEL_HINT) 모델에 가기도 전에 "어떤 여행을 찾으시나요?"
      //    로 떨어졌다 — **시킨 대로 보낸 사람이 이해 못 했다는 답을 받았다.**
      //    출발지·도착지·'항공권' 까지 들어간 예문을 보여준다.
      description:
        `다른 일정이라면 ${mentionButtonText(botName)}을 누르고\n` +
        `‘${example}’처럼 출발지와 날짜를 함께 말씀해 주세요.`,
      buttons: [t.mentionButton(botName)],
    }),
  ]);
}

/**
 * 되묻기 카드에 내놓을 **고친 날짜 후보**.
 *
 * ⚠️ **우리가 고른 날짜를 자동으로 쓰지 않는다.** 여기 있는 건 버튼 라벨이고,
 *    실제로 적용되는 건 사용자가 누른 뒤다.
 */
function choicesFor(
  problem: TripDateProblem,
  trip: TripParams,
): { label: string; depart: string; back: string | null }[] {
  if (problem.kind === 'past') {
    // 연도만 한 해 민다. **달·일은 사용자가 적은 그대로 둔다** — 거기까지 고치면
    // 무슨 날짜로 검색되는지 사용자가 못 쫓아간다.
    //
    // ⚠️ **귀국일도 같이 민다.** 출발일만 밀면 왕복으로 물은 사람이 편도 링크를
    //    받는다 — 되묻기가 조건을 또 하나 버리는 꼴이 된다.
    const depart = plusYear(trip.departDate ?? problem.date);
    const back = trip.returnDate ? plusYear(trip.returnDate) : null;
    const label = back
      ? `${fullDayText(depart)} 출발 · ${fullDayText(back)} 귀국`
      : `${fullDayText(depart)} 출발 · 편도`;
    return [{ label, depart, back }];
  }

  // 거꾸로 선 일정. 두 날짜를 **바꿔 끼우는 것**이 가장 흔한 의도다
  // (11월 23일 출발 11월 20일 귀국 → 11월 20일 출발 11월 23일 귀국).
  const swapped = {
    label: `${fullDayText(problem.back)} 출발 · ${fullDayText(problem.depart)} 귀국`,
    depart: problem.back,
    back: problem.depart,
  };
  // 출발일을 그대로 두고 싶은 사람도 있다. 3박이 가장 흔한 일정이다.
  const later = addDays(problem.depart, 3);
  return [
    swapped,
    {
      label: `${fullDayText(problem.depart)} 출발 · ${fullDayText(later)} 귀국`,
      depart: problem.depart,
      back: later,
    },
  ];
}

/**
 * **호텔판 날짜 되묻기.** 항공권의 [fixDatesCard](#fixDatesCard) 와 같은 일을 하되
 * 말이 다르다 — 출발·귀국이 아니라 체크인·체크아웃이고, **같은 날이 하나 더 있다.**
 *
 * ⚠️ **호텔은 0박을 검색할 수 없다.** 항공권에서 같은 날은 당일치기라 멀쩡한 일정이고,
 *    그래서 같은 카드를 돌려쓸 수 없다. 조용히 1박으로 늘리는 것도 안 된다 — 사용자가
 *    콕 집어 말한 날짜라 말한 적 없는 일정으로 링크가 나간다.
 *
 * ⚠️ 카카오에는 날짜 선택 버튼이 없다(action 은 `webLink`·`message`·`block`·`phone`·
 *    `share`·`operator` 가 전부). **후보를 message 버튼으로 내놓는 것이 유일한 길**이고,
 *    누르면 고쳐진 문장이 그대로 전송돼 평소 경로를 탄다.
 */
export function fixStayDatesCard(
  meta: SearchMeta,
  trip: TripParams,
  problem: StayDateProblem,
  botName: string | null,
): t.Json {
  const say = (checkIn: string, checkOut: string): string =>
    `${meta.placeName} 호텔 ${fullDayText(checkIn)} 체크인 ${fullDayText(checkOut)} 체크아웃`;

  // ⚠️ **이유는 헤더가 아니라 말풍선에 쓴다.** 리스트 카드 헤더는 한 줄만 보이고
  //    넘치면 「…」로 잘려서, 무엇이 틀렸는지가 통째로 사라진다 (항공권에서 겪었다).
  let reason: string;
  if (problem.kind === 'past') {
    reason = `${fullDayText(problem.date)}은 이미 지난 날짜예요.\n아래에서 새로운 숙박 날짜를 선택해 주세요.`;
  } else if (problem.kind === 'reversed') {
    reason =
      `체크아웃(${fullDayText(problem.back)})이 체크인(${fullDayText(problem.depart)})보다 빨라요.\n` +
      '아래에서 숙박 일정을 다시 선택해 주세요.';
  } else {
    reason =
      `체크인과 체크아웃이 ${fullDayText(problem.date)}로 같아요.\n` +
      '호텔 검색은 1박 이상 일정으로 도와드릴 수 있어요. 아래에서 숙박 기간을 선택해 주세요.';
  }

  // ⚠️ **예문에는 연도를 안 쓴다.** 버튼과 달리 한 해가 지나도 그대로 남는 글이라,
  //    연도를 박으면 지난 날짜를 예문으로 권하게 된다. 연도가 없으면 파서가 다음 해로
  //    굴려서 항상 미래 날짜가 된다.
  const example = `${meta.placeName} 호텔 12월 1일 체크인 12월 3일 체크아웃`;

  const items = stayChoicesFor(problem, trip).map((choice) => ({
    title: t.cut(choice.label, t.MAX_LIST_ITEM_TITLE),
    description: t.cut('이 일정으로 링크 보기', t.MAX_LIST_ITEM_DESC),
    action: 'message',
    messageText: say(choice.checkIn, choice.checkOut),
  }));

  return t.skillResponse([
    { simpleText: { text: reason } },
    {
      listCard: {
        header: { title: t.cut('숙박 날짜를 확인해 주세요', t.MAX_LIST_HEADER_TITLE) },
        items: items.slice(0, t.MAX_LIST_ITEMS),
      },
    },
    t.textCard({
      description:
        `다른 일정이라면 ${mentionButtonText(botName)}을 누르고\n` +
        `‘${example}’처럼 날짜를 함께 말씀해 주세요.`,
      buttons: [t.mentionButton(botName)],
    }),
  ]);
}

/**
 * 호텔 되묻기 카드에 내놓을 **고친 날짜 후보.**
 *
 * ⚠️ 우리가 고른 날짜를 자동으로 쓰지 않는다. 여기 있는 건 버튼 라벨이고, 실제로
 *    적용되는 건 사용자가 누른 뒤다.
 */
function stayChoicesFor(
  problem: StayDateProblem,
  trip: TripParams,
): { label: string; checkIn: string; checkOut: string }[] {
  const label = (checkIn: string, checkOut: string): string =>
    `${fullDayText(checkIn)} 체크인 · ${fullDayText(checkOut)} 체크아웃`;

  if (problem.kind === 'past') {
    // 연도만 한 해 민다. **달·일은 사용자가 적은 그대로 둔다** — 거기까지 고치면
    // 무슨 날짜로 검색되는지 사용자가 못 쫓아간다.
    const checkIn = plusYear(trip.departDate ?? problem.date);
    // 체크아웃을 안 말했으면 1박. 안 민 채로 두면 **지난 날짜가 그대로 남는다.**
    const checkOut = trip.returnDate ? plusYear(trip.returnDate) : addDays(checkIn, 1);
    return [{ label: label(checkIn, checkOut), checkIn, checkOut }];
  }

  if (problem.kind === 'reversed') {
    // 두 날짜를 **바꿔 끼우는 것**이 가장 흔한 의도다.
    const swapped = { label: label(problem.back, problem.depart), checkIn: problem.back, checkOut: problem.depart };
    // 체크인을 그대로 두고 싶은 사람도 있다. 그때는 1박이 가장 흔하다.
    const oneNight = addDays(problem.depart, 1);
    return [swapped, { label: label(problem.depart, oneNight), checkIn: problem.depart, checkOut: oneNight }];
  }

  // 같은 날. 며칠을 묵을지는 아무도 말하지 않았으므로 1박·2박을 내놓는다.
  const first = addDays(problem.date, 1);
  const second = addDays(problem.date, 2);
  return [
    { label: `${label(problem.date, first)} (1박)`, checkIn: problem.date, checkOut: first },
    { label: `${label(problem.date, second)} (2박)`, checkIn: problem.date, checkOut: second },
  ];
}

/** '2027-10-20' → '2027년 10월 20일'. **연도를 반드시 찍는다** — 7번이 연도 문제다. */
function fullDayText(iso: string): string {
  return `${iso.slice(0, 4)}년 ${dayText(iso)}`;
}

function plusYear(iso: string): string {
  return `${Number(iso.slice(0, 4)) + 1}${iso.slice(4)}`;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 카드 아래 안내 말풍선. **필요할 때만 붙는다.**
 *
 * 예전에는 "AI가 정리한 참고 정보예요. 가격은 실제와 다를 수 있어요." 를 항상 달았는데,
 * 매 카드마다 같은 문장이 반복돼 말풍선이 두 개씩 쌓였다. 뺐다.
 *
 * ⚠️ **`ignored` 고지는 남긴다. 이건 취향이 아니라 이 설계의 전제 조건이다.**
 *    캐시를 지역으로만 가르기 때문에 "9월 22~24일 4명" 을 말한 사람도 지역 기준 결과를
 *    받는다. 그 날짜에 예약 불가한 호텔과 다른 가격이 섞일 수밖에 없는데, 말없이 주면
 *    사용자는 속았다고 느낀다. 출발지 추정도 같은 이유로 남긴다(고쳐 말할 단서다).
 *
 * "예전에 찾아둔 정보예요" 도 뺐다. 만료된 결과는 그대로 보여주고 **뒤에서 조용히
 * 새로 찾는다** — 사용자가 할 수 있는 일이 없는 사정을 알릴 이유가 없다.
 *
 * 남길 게 하나도 없으면 **빈 문자열**을 주고, 그러면 말풍선 자체가 안 나간다.
 */
export function noticeText(opts: {
  ignored?: string[];
  meta?: SearchMeta;
  /** 발화에서 읽은 날짜·인원. 링크가 그 값으로 열리므로 **그대로 적는다.** */
  trip?: TripParams | null;
  now?: Date;
  /**
   * 이 카드에 **제휴 링크가 섞여 있는가.**
   *
   * 판정은 호출부가 한다 — 줄마다 merchant 가 다르고, 애드픽이 취급하지 않는
   * 제휴몰(스카이스캐너)만 남은 카드는 제휴 카드가 아니기 때문이다
   * ([adpick.service.ts](../adpick/adpick.service.ts) `adpickCarries`).
   */
  affiliate?: boolean;
  /**
   * 호텔 전용. **이 카드의 줄들이 실제로 날짜·인원이 박힌 주소를 가리키는가.**
   *
   * ⚠️ **붙는 것과 닿는 것은 다르다.** 형식을 아는 제휴몰만 조건을 받고(`withStay`),
   *    받았더라도 애드픽 경유에서 쿼리가 날아가는 곳이 있다(호텔스닷컴). 한 줄이라도
   *    안 닿는 카드에 "링크는 ...으로 열려요" 를 적으면 그 줄을 누른 사람은 적힌 날짜와
   *    다른 페이지를 보고 **그 안내를 믿고 예약하러 간다** — 판정은 호출부가 한다
   *    ([hotel/search-url.ts](../hotel/search-url.ts) `stayReachesUser`).
   */
  stayApplied?: boolean;
}): string {
  const lines: string[] = [];

  // ⚠️ **관광지만 "관광지 목록에" 를 붙인다.** 관광지는 조건을 넣을 링크 자체가 없어
  //    목록에 못 넣은 것이 맞지만, 호텔·항공권의 이 목록에는 **애초에 어디에도 안 쓰는
  //    것**(예산·테마)이 섞여 있다. 거기에 「링크에 못 넣었어요」를 붙이면 링크만
  //    고치면 예산이 반영될 것처럼 들린다 — 예산은 고쳐도 안 쓴다.
  //
  // ⚠️ **관광지는 이름표를 안 붙인다.** 관광지에는 날짜·인원·예산·테마가 뒤섞여 걸리는데,
  //    이름표를 앞에 세우면 「날짜·인원(아이랑, 11월 20일)」처럼 괄호 안과 짝이 안 맞는
  //    줄이 나온다. 괄호에 **사용자가 말한 표현이 그대로** 들어 있으므로 이름표가 없어도
  //    자기 말과 이을 수 있다.
  const ignored = sortConditions((opts.ignored ?? []).filter(Boolean));
  if (ignored.length) {
    lines.push(
      opts.meta?.kind === 'attraction'
        ? `요청하신 조건(${ignored.join(', ')})은 관광지 목록에 반영되지 않았어요.`
        : `${conditionLabel(ignored)}(${ignored.join(', ')})은 반영되지 않았어요.`,
    );
  }

  // ⚠️ **링크가 어떤 조건으로 열리는지 반드시 말한다.** 우리가 날짜·인원을 넣어
  //    검색된 페이지를 열기 때문에([search-url.ts](../flight/search-url.ts)), 사용자가
  //    말하지 않은 칸은 우리가 고른 값이다. 적어두면 틀렸을 때 고칠 수 있고,
  //    안 적으면 "왜 내 날짜가 아니지" 로 끝난다.
  if (opts.meta?.kind === 'flight') {
    const tripType = opts.meta.tripType === 'ow' ? 'oneway' : 'round';
    const resolved = resolveTrip(tripType, opts.trip, opts.now ?? new Date());
    // ⚠️ **실시간 항공편·요금을 찾아준 것이 아니다.** 우리가 하는 일은 예약 사이트의
    //    검색 화면을 조건까지 채워서 여는 것뿐이다. 이 줄이 없으면 카드 제목
    //    (「서울→오사카 항공권」)만 보고 **좌석과 운임을 확인해 준 줄 안다.**
    lines.push('아래 예약 사이트에서 항공편과 요금을 확인해 주세요.');
    lines.push(tripNoticeText(resolved));
    if (resolved.adultsClamped) {
      lines.push(flightAdultsClampedText(resolved.adultsAsked, FLIGHT_MAX_ADULTS));
    }
    if (opts.affiliate) lines.push(affiliateNotice('flight'));
  }

  // ⚠️ **호텔은 추천 목록과 링크가 다른 조건이다.** AI 목록은 지역으로만 찾고(캐시를
  //    지역으로 가른다) 날짜·인원은 **링크에만** 들어간다 — 목록까지 그 날짜로 고른 줄
  //    알면 예약 가능 여부를 오해한다.
  if (opts.meta?.kind === 'hotel') {
    // ⚠️ **방금 찾은 요금도, 예약 가능한 객실도 아니다.** 목록은 하루를 사는 캐시이고
    //    (`search_results`) 요금은 카드에 아예 안 적는다. 그 사실을 말하지 않으면
    //    사용자는 카드에 보이는 호텔이 그 날짜에 비어 있다고 읽는다.
    //
    // ⚠️ **사이트 이름을 대는 건 `stayApplied` 쪽뿐이다.** 새로 찾은 목록은 트립닷컴만
    //    남지만(openai.provider `ALLOWED_HOSTS`), 조건이 안 닿는 카드는 그 전에 저장된
    //    다른 제휴몰 줄이 섞인 경우다. 거기에 「트립닷컴으로 이동해요」를 적으면
    //    누른 사람이 다른 사이트를 보게 된다.
    if (opts.stayApplied) {
      lines.push('호텔을 누르면 트립닷컴 상세 페이지로 이동해요.');
      lines.push('예약 가능 여부와 최종 요금은 트립닷컴에서 확인해 주세요.');
    } else {
      lines.push('예약 가능 여부와 최종 요금은 예약 사이트에서 확인해 주세요.');
      // ⚠️ **조건이 링크에 안 닿았을 때만 붙인다** (H06). 그 사람은 링크를 열어 날짜를
      //    **직접 다시 넣어야** 하는데, 위의 「반영되지 않았어요」만으로는 거기서 뭘
      //    해야 하는지가 안 보인다.
      lines.push('예약 사이트에서 날짜와 인원을 다시 확인해 주세요.');
    }

    if (opts.affiliate) lines.push(affiliateNotice('hotel'));

    if (opts.stayApplied) {
      const stay = resolveStay(stayOf(opts.trip), opts.now ?? new Date());
      // 인원을 줄였으면 **몇 명으로 열리는지보다 먼저** 말한다. 숫자만 보고 지나가면
      // 8명이 묵을 방을 찾아준 줄 안다.
      if (stay.adultsClamped) {
        lines.push(`호텔 링크에는 객실 ${stay.rooms}개·최대 ${HOTEL_MAX_ADULTS}명까지만 넣을 수 있어요.`);
        lines.push(hotelAdultsClampedText(stay.adultsAsked, HOTEL_MAX_ADULTS));
      }
      lines.push(stayNoticeText(stay));
      // ⚠️ **이 한 줄이 이 카드에서 가장 중요한 고지다.** 위 줄만 읽으면 "이 날짜로
      //    고른 호텔" 로 읽히는데, 목록은 지역으로만 고른다. 조건에 맞는 호텔을
      //    선별해 준 것처럼 두면 그 날짜에 못 묵는 호텔을 추천으로 받는다.
      //
      // 아무 조건도 말하지 않은 사람에게는 붙이지 않는다 — 거르는 조건을 준 적이
      // 없으니 목록이 걸러진 줄 오해할 일도 없다.
      if (stay.datesAsked || stay.adultsAsked !== null) {
        lines.push('추천 목록 자체는 날짜와 인원에 따라 달라지지 않아요.');
      }
    }
  }

  // 출발지를 추측했으면 반드시 알려준다. 부산에서 가려던 사람이 고쳐 말할 유일한 단서다.
  //
  // ⚠️ **맨 아래로 내렸다 (2026-11-18).** 그 전에는 제휴 고지가 맨 아래였다 — 행동할
  //    정보를 먼저 보여준다는 이유였는데, 이 고지는 두 줄이고 끝이 「이렇게 말씀해
  //    주세요」라서 마지막 자리가 더 세게 읽힌다.
  if (opts.meta?.kind === 'flight' && opts.meta.originAssumed && opts.meta.fromName) {
    const from = opts.meta.fromName;
    lines.push(`출발지를 말씀하지 않아 ${from}${AIRPORT_OF[from] ? `(${AIRPORT_OF[from]})` : ''} 기준으로 안내했어요.`);
    lines.push(
      `다른 곳에서 출발하시면 ‘${flightExample(opts.meta.placeName, otherOrigin(opts.meta.placeName))}’처럼 ` +
        '출발지와 도착지를 함께 말씀해 주세요.',
    );
  }

  return lines.join('\n');
}

/**
 * 제휴 고지. **링크를 누르기 전에 보여야 한다.**
 *
 * 카드 줄은 우리 리다이렉트(`/r/{clickId}`)를 가리키고 그 302 목적지가 애드픽
 * 커미션 링크다([redirect.controller.ts](../redirect/redirect.controller.ts)).
 * 사용자는 그 사실을 알 길이 없으므로 카드 아래에 적는다.
 *
 * ⚠️ **말풍선을 새로 만들지 않는다.** 카드 + 고지 + 멘션 버튼이 이미 MAX_OUTPUTS(3)
 *    로 꽉 차서, 하나 더 얹으면 멘션 버튼이 조용히 잘린다
 *    ([templates.ts](./templates.ts)). 기존 고지에 한 줄로 합친다.
 */
export const AFFILIATE_NOTICE = '아래 링크에는 제휴 링크가 포함되어 있어요.';

/**
 * 제휴 고지. **무엇을 누르는 링크인지에 따라 말이 다르다.**
 *
 * 호텔 카드의 줄은 호텔 하나하나로 가고, 항공권 카드의 줄은 예약 사이트의 검색
 * 화면으로 간다. 「아래 링크」라고만 하면 어느 링크를 말하는지가 안 보인다 —
 * 빈손 카드(`emptyFallbackNotice`)처럼 둘 다 아닌 자리에는 `AFFILIATE_NOTICE` 를 쓴다.
 */
function affiliateNotice(kind: SearchKind | undefined): string {
  if (kind === 'hotel') return '아래 호텔 링크에는 제휴 링크가 포함되어 있어요.';
  if (kind === 'flight') return '아래 예약 사이트 링크에는 제휴 링크가 포함되어 있어요.';
  return AFFILIATE_NOTICE;
}

/**
 * 기본 출발지에 붙여줄 공항 이름.
 *
 * ⚠️ **「서울 기준」만으로는 어느 공항인지 모른다.** 인천과 김포는 가는 길이 다르다.
 *    기본 출발지는 설정값(`FLIGHT_DEFAULT_ORIGIN_NAME`)이라 바뀔 수 있으므로, 아는
 *    이름에만 붙이고 모르면 도시 이름만 적는다.
 */
const AIRPORT_OF: Record<string, string> = { 서울: '인천' };

/**
 * '2026년 10월 20일 출발 · 2026년 10월 24일 귀국 · 4명 · 왕복'.
 *
 * ⚠️ **링크를 만드는 함수와 같은 곳에서 값을 받아 적는다** (`resolveTrip`). 여기서
 *    기본값을 따로 쓰면 "내일 출발" 이라고 적어놓고 다른 날로 여는 카드가 나온다.
 */
/**
 * 링크가 어떤 조건으로 열리는지 한 줄.
 *
 * ⚠️ **우리가 채운 값은 채웠다고 말한다.** 날짜·인원을 말하지 않은 사람에게
 *    「링크는 11월 19일 출발 … 기준으로 열려요」만 보여주면 그 날짜를 자기가 고른
 *    줄 알고 그대로 예약하러 간다. 무엇을 우리가 골랐는지 적어야 고쳐 말할 수 있다.
 */
function stayNoticeText(stay: ResolvedStay): string {
  // 「2박」이라고 말한 사람에게는 그 말이 그대로 보여야 한다. 체크아웃만 적으면
  // 우리가 센 날이 맞는지 확인할 길이 없다.
  const when = stay.nightsAsked
    ? `${fullDayText(stay.checkIn)}부터 ${stay.nightsAsked}박 · ${fullDayText(stay.checkOut)} 체크아웃`
    : `${fullDayText(stay.checkIn)} 체크인 · ${fullDayText(stay.checkOut)} 체크아웃`;
  const where = `${when} · ${stay.adults}명 · 객실 ${stay.rooms}개`;

  // ⚠️ **한쪽만 빠졌으면 그쪽만 짚는다** — 항공권(`tripNoticeText`)과 같은 규칙이다.
  //    「2박」만 말한 사람에게 「날짜와 인원을 말씀하지 않아」라고 하면 자기가 말한 것을
  //    못 들은 게 되고, 반대로 뭉뚱그려 「열려요」라고만 하면 우리가 고른 인원을 자기가
  //    고른 줄 안다.
  const missing: string[] = [];
  if (!stay.datesAsked) missing.push('날짜');
  if (stay.adultsAsked === null) missing.push('인원');
  if (!missing.length) return `링크는 ${where} 기준으로 열려요.`;
  return `${withObjectParticle(missing.join('와 '))} 말씀하지 않아 ${where} 기준으로 안내했어요.`;
}

function tripNoticeText(resolved: ResolvedTrip): string {
  const missing: string[] = [];
  if (!resolved.datesAsked) missing.push('날짜');
  if (resolved.adultsAsked === null) missing.push('인원');
  if (!missing.length) return `링크는 ${tripText(resolved)} 기준으로 열려요.`;
  return `${withObjectParticle(missing.join('와 '))} 말씀하지 않아 ${tripText(resolved)} 기준으로 안내했어요.`;
}

function tripText(resolved: ResolvedTrip): string {
  const { depart, back, adults } = resolved;
  // ⚠️ **연도를 적는다.** 12월에 「1월 5일 출발」만 보면 올해인지 내년인지 모른다.
  const parts = [`${fullDayText(depart)} 출발`];
  if (back) parts.push(`${fullDayText(back)} 귀국`);
  parts.push(`${adults}명`);
  // ⚠️ **왕복·편도를 글자로 박는다.** 귀국일이 있고 없고로 구분하게 두면, 날짜를
  //    안 말해 기본값이 들어간 사람은 두 날짜만 보고 그게 자기가 고른 일정인 줄 안다.
  parts.push(back ? '왕복' : '편도');
  return parts.join(' · ');
}

/**
 * 말한 인원을 우리가 줄였을 때.
 *
 * ⚠️ **말풍선을 새로 만들지 않는다.** 카드 + 고지 + 멘션 버튼이 이미 MAX_OUTPUTS(3)
 *    으로 꽉 차서 하나 더 얹으면 멘션 버튼이 조용히 잘린다. 기존 고지에 한 줄로 붙인다.
 */
function flightAdultsClampedText(asked: number | null, max: number): string {
  const head = asked ? `요청하신 ${asked}명 대신 ` : '';
  return `${head}${max}명으로 열려요. 링크에는 ${max}명까지만 넣을 수 있어요.`;
}

/**
 * 호텔판. **객실 수까지 말해야 한다.**
 *
 * 6명은 「객실 1개에 넣을 수 있는 최대」지 「우리가 찾아준 인원」이 아니다. 8명이라고
 * 말한 사람에게 숫자만 6으로 바꿔 주면 8명이 묵을 방을 찾아준 줄 알고 예약하러 간다 —
 * 방을 몇 개로 쪼갤지는 우리가 알 수 없으므로 **거기서 다시 고르라고** 말한다.
 */
function hotelAdultsClampedText(asked: number | null, max: number): string {
  const head = asked ? `요청하신 ${asked}명 대신 ` : '';
  return `${head}${max}명으로 열리니, 예약 사이트에서 전체 인원과 객실 수를 다시 설정해 주세요.`;
}

/** '2026-10-20' → '10월 20일'. 연도는 적지 않는다 — 카드 한 줄이 좁다. */
function dayText(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

const DATE_RE = /\d+\s*(월|일|\/)|내일|모레|주말|다음\s*주|다음주|담주|이번주|다음\s*달|다음달/;
const ADULTS_RE = /\d+\s*(명|인)/;
// ⚠️ **"1박" 은 날짜가 아니라 가격 기준이다.** "1박 10만원 이하" 의 1박은 머무는
//    기간이 아니라 **하루치 가격**을 말한다. 날짜로 분류하면 "날짜는 반영되지
//    않았어요" 가 붙는데, 날짜를 반영하는 지금은 그게 거짓말이 된다.
const BUDGET_RE = /만원|\d+\s*박/;
// 동행·분위기. "아이랑" 을 '인원' 이라고 하면 틀린 이름이고, 이름이 틀리면
// 사용자는 자기가 말한 것과 고지된 것을 못 잇는다.
const THEME_RE = /아이|애기|애들|아기|가족|부모님|친구|연인|커플|혼자|야경|일몰|노을|실내|조용한|한적한|이색|힐링/;

/** ["4명", "9/22~24"] → '날짜·인원'. 무엇을 버렸는지 이름을 붙여준다. */
function conditionLabel(ignored: string[]): string {
  const labels: string[] = [];
  const joined = ignored.join(' ');
  if (DATE_RE.test(joined)) labels.push('날짜');
  if (ADULTS_RE.test(joined)) labels.push('인원');
  if (BUDGET_RE.test(joined)) labels.push('예산');
  if (THEME_RE.test(joined)) labels.push('테마');
  return labels.length ? labels.join('·') : '일부 조건';
}

/**
 * 괄호 안 조건을 **이름표와 같은 순서로** 세운다 — 날짜 · 인원 · 예산 · 테마.
 *
 * ⚠️ **들어온 순서는 사용자가 말한 순서가 아니다.** 발화에서 조건을 긁는 정규식이
 *    인원(`\d+명`)부터 돌기 때문에([intent.types.ts](../intent/intent.types.ts)
 *    `CONDITION_PATTERNS`) "11월 20일 3명" 이라고 말해도 `['3명', '11월 20일']` 로
 *    온다. 그대로 적으면 「날짜·인원(3명, 11월 20일)」처럼 이름표와 괄호가 엇갈린다.
 */
function sortConditions(ignored: string[]): string[] {
  return [...ignored].sort((a, b) => conditionOrder(a) - conditionOrder(b));
}

/** 조건 하나를 날짜(0)·인원(1)·예산(2)·테마(3)·그 밖(4) 중 하나로 매긴다. */
function conditionOrder(text: string): number {
  // ⚠️ **예산을 먼저 본다.** "1박 2일" 은 날짜 정규식의 "일" 에도 걸리지만 가격 기준이다.
  if (BUDGET_RE.test(text)) return 2;
  if (DATE_RE.test(text)) return 0;
  if (ADULTS_RE.test(text)) return 1;
  if (THEME_RE.test(text)) return 3;
  return 4;
}

/** 다른 사람이 먼저 같은 걸 물어 검색이 돌고 있는 경우. */
export function busyText(meta: SearchMeta, botName: string | null): t.Json {
  // ⚠️ **"완료되면 보내드릴게요" 라고 하면 안 된다.** 콜백은 먼저 선점한 요청 하나에만
  //    달려 있어서, 이 사람에게는 아무것도 안 온다. 다시 물어야 저장된 결과를 받는다 —
  //    그래서 **무엇이라고 다시 말하면 되는지**까지 적는다.
  return t.simpleTextWithMention(
    `${subject(meta)} 정보를 이미 찾고 있어요.\n` +
      `잠시 후 ‘${exampleUtterance(meta.placeName, meta.kind)}’라고 다시 말씀해 주세요.`,
    botName,
  );
}

/**
 * 콜백이 꺼져 있을 때의 미스 응답.
 *
 * 검색은 이미 백그라운드에서 돈다. 다시 물으면 저장된 결과가 바로 나간다 —
 * 콜백 없이 20초를 기다리게 할 방법이 없어서 둔 차선책이다.
 */
export function searchStartedText(meta: SearchMeta, botName: string | null): t.Json {
  // ⚠️ **걸리는 시간을 숫자로 약속하지 않는다.** 「30초쯤」이라고 적었는데 실제로는
  //    7초에 끝나기도 하고 50초를 넘기기도 한다. 30초에 다시 물어 또 "찾고 있어요" 를
  //    받은 사람은 봇이 고장 났다고 읽는다.
  return t.simpleTextWithMention(
    `${withObjectParticle(subject(meta))} 찾고 있어요.\n` +
      '정리가 끝나면 바로 보여드릴게요. 잠시 뒤 다시 말씀해 주세요.',
    botName,
  );
}

/**
 * 결과가 비었을 때.
 *
 * ⚠️ **"도시나 지역 이름을 확인해 다시 말씀해 주세요" 로 바꿨다 (2026-11-18).** 그 전에는
 *    "잠시 뒤 다시 물어봐 주세요" 였다 — 지역은 제대로 알아들었는데 검색만 실패한 경우가
 *    대부분이라, 사용자를 틀린 쪽으로 몰면 안 된다고 봤기 때문이다. 다만 빈손은
 *    `FAILED_TTL_MINUTES` 동안 굳어서 **같은 말을 다시 하면 같은 문구만 돌아온다.**
 *    기다리라고만 하면 거기서 막다른 길이고, 말을 바꾸면 캐시 키가 달라져 실제로 길이
 *    열린다. 바로 아래 `narrowerHint` 가 같은 이유로 붙어 있다.
 */
/**
 * 항공권 링크를 만들 수 없는 노선 ([airports.ts](../flight/airports.ts) routeProblem).
 *
 * ⚠️ "잠시 뒤 다시 물어봐 주세요" 라고 하지 않는다. 다시 물어도 같은 답이다 —
 *    무엇을 바꿔 말하면 되는지를 적는다.
 */
export function flightRouteText(problem: RouteProblem, botName: string | null): t.Json {
  // ⚠️ **"공항이 없어요" 라고 단정하지 않는다.** 우리가 아는 것은 「그 지명으로는
  //    링크를 못 만든다」 뿐이고, 그건 공항이 없어서일 수도 있고 우리 대조표에 없어서일
  //    수도 있다. 지리를 단정하면 공항이 있는 도시에까지 틀린 말을 하게 된다 —
  //    사용자가 할 수 있는 일(다른 도시로 말하기)은 어느 쪽이든 같으므로, **현재
  //    지원 범위**만 말한다.
  let text: string;
  if (problem.kind === 'same') {
    text = problem.originAssumed
      ? `출발지를 말씀하지 않아 ${problem.name} 기준으로 보니 도착지와 같아요.\n` +
        `‘부산에서 ${problem.name} 항공권’처럼 출발지를 함께 말씀해 주세요.`
      : `출발지와 도착지가 모두 ${problem.name}으로 되어 있어요.\n` +
        `서로 다른 출발 도시와 도착 도시를 알려주세요.`;
  } else if (problem.kind === 'no-origin-airport') {
    // ⚠️ **예문의 출발지는 물어본 나라에서 고른다.** 「서울에서 서울 항공권」을 권한
    //    적이 있다 — 도착지가 서울일 때 예문이 출발지·도착지가 같은 문장이 됐다.
    //    사전에 없는 나라면 예문 없이 묻는다. 지어낸 도시보다 낫다.
    const from = COUNTRY_DEPARTURE_EXAMPLE[problem.name];
    text = problem.isCountry
      ? `${problem.name}의 어느 도시에서 출발하시나요?\n` +
        (from
          ? `‘${flightExample(problem.dest, from)}’처럼 출발 도시를 포함해 다시 말씀해 주세요.`
          : '출발 도시를 포함해 다시 말씀해 주세요.')
      : `현재 ${problem.name} 출발 항공권 링크는 제공하지 않아요.\n` +
        '이용하실 공항이 있는 도시를 출발지로 넣어 다시 말씀해 주세요.';
  } else {
    text =
      `현재 ${problem.name} 도착 항공권 링크는 제공하지 않아요.\n` +
      `이용하실 공항이 있는 도시를 도착지로 알려주세요.`;
  }
  return t.simpleTextWithMention(text, botName);
}

export function emptyText(meta: SearchMeta, botName: string | null): t.Json {
  // ⚠️ **빈 힌트를 템플릿에 끼워 넣지 마라.** 예전에는 `주세요. ${hint}` 였는데,
  //    힌트가 빈 문자열이면 문장 끝에 공백이 남았다.
  const hint = narrowerHint(meta);
  return t.simpleTextWithMention(
    `지금은 ${subject(meta)} 정보를 정리하지 못했어요.\n` +
      ['도시나 지역 이름을 확인해 다시 말씀해 주세요.', hint].filter(Boolean).join(' '),
    botName,
  );
}

/**
 * 빈손일 때 **지금 해볼 수 있는 것**.
 *
 * ⚠️ "잠시 뒤 다시" 만 주면 막다른 길이다. 빈손은 `FAILED_TTL_MINUTES` 동안
 *    굳으므로 같은 말을 반복하면 같은 문구만 돌아오고, 사용자는 봇이 고장 난 줄 안다.
 *
 * **지역을 좁히면 실제로 다른 길이 열린다** — 캐시 키가 달라져 굳은 행을 비켜 가고,
 * 세부 지역은 검색 질의도 좁아진다 ("도쿄" → "신주쿠 도쿄").
 */
function narrowerHint(meta: SearchMeta): string {
  // 항공권은 노선이 이미 확정이라 좁힐 자리가 없다 — 괜히 권하면 딴소리다.
  if (meta.kind === 'flight') return '';
  // ⚠️ **이미 동네를 말한 사람에게 동네를 말하라고 하지 않는다.** "도쿄 신주쿠 호텔"
  //    을 물은 사람이 "동네 이름을 붙여 말해도 좋아요 (예: 도쿄 신주쿠)" 를 받았다 —
  //    시킨 대로 이미 했는데 같은 말이 돌아오면 사용자는 봇이 고장 났다고 읽는다.
  if (meta.placeKind === 'area' || meta.placeKind === 'landmark') return '';
  // ⚠️ 예시에 **그 사람이 말한 도시를 끼워 넣지 않는다.** 동네 이름을 모르므로
  //    "오사카 신주쿠" 같은 없는 조합이 나간다. 고정 예시가 덜 똑똑해도 안 틀린다.
  return '동네 이름을 붙여 말해도 좋아요 (예: 도쿄 신주쿠).';
}

/**
 * 빈손이지만 **직접 만든 검색 링크는 줄 수 있을 때.**
 *
 * `emptyText` 는 막다른 길이다 — 빈손은 짧게 굳으므로(FAILED_TTL_MINUTES) 같은 말을
 * 반복하면 같은 문구만 돌아오고, 사용자는 봇이 고장 난 줄 안다. 모델이 빈손이어도
 * **그 지역 호텔 검색 결과**는 우리가 열어줄 수 있다.
 */
export function emptyFallbackHeader(meta: SearchMeta): string {
  return `${meta.placeName} ${KIND_LABEL[meta.kind]} 직접 찾아보기`;
}

/**
 * 그 줄이 왜 거기 있는지 한 줄로. **없으면 사용자는 이게 추천인 줄 안다.**
 *
 * 평소 카드는 "우리가 고른 다섯 곳" 인데 이건 "직접 보시라" 라서, 말 안 하면
 * 추천 품질이 갑자기 나빠진 것처럼 보인다.
 */
export function emptyFallbackNotice(meta: SearchMeta): string {
  return (
    `지금은 추천할 ${KIND_LABEL[meta.kind]} 목록을 정리하지 못했어요.\n` +
    `아래 링크에서 ${meta.placeName} ${withObjectParticle(KIND_LABEL[meta.kind])} 직접 확인해 주세요.\n` +
  // ⚠️ **이 줄을 빼면 안 된다.** 이 카드의 링크는 제휴 경유에서 날짜·인원이
  //    날아가는 제휴몰이다(호텔스닷컴). 평소 카드처럼 「링크는 … 으로 열려요」가
  //    붙지 않는 이유이고, 그 침묵만으로는 사용자가 알 길이 없다.
    '날짜와 인원은 예약 사이트에서 다시 확인해 주세요.'
  );
}

/**
 * 검색을 **아예 할 수 없는 상태** (provider 에 키가 없다 등).
 *
 * ⚠️ "30초쯤 뒤에 다시 물어봐 주세요" 를 쓰면 안 된다. 결과가 영원히 안 오는데
 *    기다리게 하는 것이고, 사용자는 그 사이 같은 질문을 반복한다. 운영자에게는
 *    /health 의 openai 필드와 서버 로그가 신호다.
 */
export function unavailableText(meta: SearchMeta, botName: string | null): t.Json {
  // ⚠️ **"고쳐두는 대로 다시 알려드릴게요" 는 지킬 수 없는 약속이었다.** 복구를 감지해
  //    먼저 말을 거는 경로가 우리에게 없다. 콜백은 그 요청 하나에 5분·1회로 묶여 있고
  //    선톡은 별도 심사다. 기다리라고 해놓고 영영 안 오면 그게 가장 나쁜 실패다.
  return t.simpleTextWithMention(
    `지금은 ${subject(meta)} 정보를 불러올 수 없어요.\n잠시 후 다시 요청해 주세요.`,
    botName,
  );
}

/** 검색 자체가 실패했을 때 (모델 오류·타임아웃). */
export function failedText(meta: SearchMeta, botName: string | null): t.Json {
  return t.simpleTextWithMention(
    `${withObjectParticle(subject(meta))} 불러오지 못했어요.\n잠시 뒤 다시 시도해 주세요.`,
    botName,
  );
}

/** '오사카 호텔' / '서울→오사카 항공권'. 상황 문구가 공유하는 주어. */
export function subject(meta: SearchMeta): string {
  if (meta.kind === 'flight') {
    return `${meta.fromName ?? '서울'}→${meta.placeName} 항공권`;
  }
  return `${meta.placeName} ${KIND_LABEL[meta.kind]}`;
}

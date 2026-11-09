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
      title: '🤔 어떤 여행을 찾으시나요?',
      description: '요청하신 내용을 정확히 이해하지 못했어요.\n아래 예시를 참고해 다시 말씀해 주세요!',
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
    '아직 정리 중이에요 🔍\n잠시 뒤 같은 질문을 다시 보내주시면 바로 보여드릴게요!',
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
      headerTitle: '가자고가 도와드릴 수 있는 것',
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

  const label = KIND_LABEL[kind];

  // ⚠️ **줄을 누르면 완성된 문장이 그대로 전송된다.** message 버튼은 누르는 즉시
  //    전송되는데, 이 자리에서는 그게 정확히 원하는 동작이다 — 도시와 의도를 모두
  //    박아두면 그 발화가 라우터로 돌아와 평소 경로를 탄다.
  //
  //    단톡방에서는 봇을 멘션한 메시지만 서버로 온다. 사용자가 도시 이름을 직접 치면
  //    멘션이 빠져 **봇이 아예 듣지 못한다** — 눌러서 보내는 길이 있어야 하는 이유다.
  const card: t.Json = {
    listCard: {
      header: { title: t.cut(`${country} 어느 도시의 ${withObjectParticle(label)} 찾을까요?`, t.MAX_LIST_HEADER_TITLE) },
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
    description: `다른 도시를 찾고 있나요?\n아래 버튼을 누르고 「${example}」처럼 보내주세요.`,
    buttons: [t.mentionButton(botName)],
  });
}

/**
 * 줄을 눌렀을 때 전송될 문장.
 *
 * 항공권은 **출발지까지 박는다.** 그러면 카드 아래 "서울 출발 기준이에요" 안내가
 * 필요 없어지고, 부산에서 가려는 사람은 그 문장을 고쳐 보내면 된다.
 */
function pickUtterance(city: string, kind: SearchKind, origin: string): string {
  if (kind === 'flight') return `${origin}에서 ${city} 항공권 찾아줘`;
  return exampleUtterance(city, kind);
}

/**
 * 안내 문구에 쓸 "목록에 없는 도시" 예시.
 *
 * 나라와 상관없는 도시를 예로 들면(베트남을 묻는 사람에게 "삿포로") 안내가 아니라
 * 딴소리가 된다. 사전에 있는 그 나라 도시 하나를 고르고, 없으면 도시를 빼고 말한다.
 */
function otherCityExample(country: string): string {
  return OTHER_CITY_EXAMPLE[country] ?? '그 도시';
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
): t.Json {
  const label = KIND_LABEL[kind];
  const where = country ? `${country} 어디로 가세요?` : `어느 도시 ${withObjectParticle(label)} 찾으세요?`;

  // ⚠️ **멘션을 빼먹으면 봇이 아예 못 듣는다.** 단톡방에서는 봇을 멘션한 메시지만
  //    서버로 온다. 버튼이 그 멘션을 넣어주므로, 글은 **그 뒤에 뭘 치면 되는지**만
  //    말하면 된다 — 버튼이 없던 때는 "@봇이름 부터 치세요" 를 글로 설명해야 했다.
  const how = '아래 버튼을 누르고 도시 이름을 보내주세요. 예) 다낭';

  return t.simpleTextWithMention(`${where}\n${how}`, botName);
}

/** 무엇을 묻는지는 알겠는데 지역이 없다. 되묻되 예시로 답을 쉽게 만든다. */
export function askPlaceCard(kind: SearchKind, botName: string | null): t.Json {
  const label = KIND_LABEL[kind];
  return t.simpleTextWithMention(
    `어느 지역 ${withObjectParticle(label)} 찾으세요?\n` +
      `아래 버튼을 누르고 「${exampleUtterance(EXAMPLE_PLACE, kind)}」처럼 보내주세요.`,
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
  const reason =
    problem.kind === 'past'
      ? `${fullDayText(problem.date)}은 이미 지난 날짜예요.`
      : `귀국일(${dayText(problem.back)})이 출발일(${dayText(problem.depart)})보다 빨라요.`;
  const header = '날짜를 다시 골라주세요';

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
    description: t.cut('이 날짜로 찾기', t.MAX_LIST_ITEM_DESC),
    action: 'message',
    messageText: say(choice.depart, choice.back),
  }));

  return t.skillResponse([
    { simpleText: { text: `${reason}\n아래에서 날짜를 고르시면 바로 찾아드려요.` } },
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
        `다른 날짜로 찾으시려면 아래 버튼을 누르고\n「${example}」\n처럼 출발지까지 함께 보내주세요.`,
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
      ? `${fullDayText(depart)} 출발 · ${dayText(back)} 귀국`
      : `${fullDayText(depart)}로 바꾸기`;
    return [{ label, depart, back }];
  }

  // 거꾸로 선 일정. 두 날짜를 **바꿔 끼우는 것**이 가장 흔한 의도다
  // (11월 23일 출발 11월 20일 귀국 → 11월 20일 출발 11월 23일 귀국).
  const swapped = { label: `${dayText(problem.back)} 출발 · ${dayText(problem.depart)} 귀국`, depart: problem.back, back: problem.depart };
  // 출발일을 그대로 두고 싶은 사람도 있다. 3박이 가장 흔한 일정이다.
  const later = addDays(problem.depart, 3);
  return [
    swapped,
    { label: `${dayText(problem.depart)} 출발 · ${dayText(later)} 귀국`, depart: problem.depart, back: later },
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
    reason = `${fullDayText(problem.date)}은 이미 지난 날짜예요.`;
  } else if (problem.kind === 'reversed') {
    reason = `체크아웃(${dayText(problem.back)})이 체크인(${dayText(problem.depart)})보다 빨라요.`;
  } else {
    reason =
      `체크인과 체크아웃이 ${dayText(problem.date)}로 같아요.\n` +
      '호텔은 1박 이상이어야 찾을 수 있어요.';
  }

  // ⚠️ **예문에는 연도를 안 쓴다.** 버튼과 달리 한 해가 지나도 그대로 남는 글이라,
  //    연도를 박으면 지난 날짜를 예문으로 권하게 된다. 연도가 없으면 파서가 다음 해로
  //    굴려서 항상 미래 날짜가 된다.
  const example = `${meta.placeName} 호텔 12월 1일 체크인 12월 3일 체크아웃`;

  const items = stayChoicesFor(problem, trip).map((choice) => ({
    title: t.cut(choice.label, t.MAX_LIST_ITEM_TITLE),
    description: t.cut('이 날짜로 찾기', t.MAX_LIST_ITEM_DESC),
    action: 'message',
    messageText: say(choice.checkIn, choice.checkOut),
  }));

  return t.skillResponse([
    { simpleText: { text: `${reason}\n아래에서 날짜를 고르시면 바로 찾아드려요.` } },
    {
      listCard: {
        header: { title: t.cut('날짜를 다시 골라주세요', t.MAX_LIST_HEADER_TITLE) },
        items: items.slice(0, t.MAX_LIST_ITEMS),
      },
    },
    t.textCard({
      description: `다른 날짜로 찾으시려면 아래 버튼을 누르고\n「${example}」\n처럼 보내주세요.`,
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
    `${dayText(checkIn)} 체크인 · ${dayText(checkOut)} 체크아웃`;

  if (problem.kind === 'past') {
    // 연도만 한 해 민다. **달·일은 사용자가 적은 그대로 둔다** — 거기까지 고치면
    // 무슨 날짜로 검색되는지 사용자가 못 쫓아간다.
    const checkIn = plusYear(trip.departDate ?? problem.date);
    // 체크아웃을 안 말했으면 1박. 안 민 채로 두면 **지난 날짜가 그대로 남는다.**
    const checkOut = trip.returnDate ? plusYear(trip.returnDate) : addDays(checkIn, 1);
    return [{ label: `${fullDayText(checkIn)} 체크인 · ${dayText(checkOut)} 체크아웃`, checkIn, checkOut }];
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
   * ⚠️ 형식을 확인한 제휴몰만 조건을 받는다([hotel/search-url.ts](../hotel/search-url.ts)
   *    `withStay`). 한 줄이라도 맨 주소로 나가는 카드에 "링크는 ...으로 열려요" 를
   *    적으면 그 줄을 누른 사람은 적힌 날짜와 다른 페이지를 본다 — 판정은 호출부가
   *    한다(`staySupported`).
   */
  stayApplied?: boolean;
}): string {
  const lines: string[] = [];

  const ignored = (opts.ignored ?? []).filter(Boolean);
  if (ignored.length) {
    lines.push(`${conditionLabel(ignored)}(${ignored.join(', ')})은 반영되지 않았어요.`);
  }

  // ⚠️ **링크가 어떤 조건으로 열리는지 반드시 말한다.** 우리가 날짜·인원을 넣어
  //    검색된 페이지를 열기 때문에([search-url.ts](../flight/search-url.ts)), 사용자가
  //    말하지 않은 칸은 우리가 고른 값이다. 적어두면 틀렸을 때 고칠 수 있고,
  //    안 적으면 "왜 내 날짜가 아니지" 로 끝난다.
  if (opts.meta?.kind === 'flight') {
    const tripType = opts.meta.tripType === 'ow' ? 'oneway' : 'round';
    const resolved = resolveTrip(tripType, opts.trip, opts.now ?? new Date());
    // 카드에 가격이 없으므로 "확정 운임이 아니다" 같은 고지는 할 말이 없다.
    lines.push(`링크는 ${tripText(resolved)}으로 검색돼요.`);
    if (resolved.adultsClamped) lines.push(adultsClampedText(FLIGHT_MAX_ADULTS));
  }

  // ⚠️ **호텔은 추천 목록과 링크가 다른 조건이다.** AI 목록은 지역으로만 찾고(캐시를
  //    지역으로 가른다) 날짜·인원은 **링크에만** 들어간다. 그래서 "검색돼요" 가 아니라
  //    "열려요" 다 — 목록까지 그 날짜로 고른 줄 알면 예약 가능 여부를 오해한다.
  if (opts.meta?.kind === 'hotel' && opts.stayApplied) {
    const stay = resolveStay(stayOf(opts.trip), opts.now ?? new Date());
    lines.push(
      `링크는 ${dayText(stay.checkIn)} 체크인 · ${dayText(stay.checkOut)} 체크아웃 · ` +
        `${stay.adults}명으로 열려요.`,
    );
    if (stay.adultsClamped) lines.push(adultsClampedText(HOTEL_MAX_ADULTS));
  }

  // 출발지를 추측했으면 반드시 알려준다. 부산에서 가려던 사람이 고쳐 말할 유일한 단서다.
  if (opts.meta?.originAssumed && opts.meta.fromName) {
    lines.push(`${opts.meta.fromName} 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.`);
  }

  // ⚠️ **맨 아래에 둔다.** 사용자가 고쳐 말할 수 있는 정보(반영 안 된 조건·출발지)가
  //    먼저고, 이건 읽고 끝나는 고지다. 위에 두면 행동할 정보를 밀어낸다.
  if (opts.affiliate) lines.push(AFFILIATE_NOTICE);

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
export const AFFILIATE_NOTICE = '본 검색 결과에는 제휴 업체가 포함되어 있습니다.';

/**
 * '10월 20일 출발 · 24일 귀국 · 4인'.
 *
 * ⚠️ **링크를 만드는 함수와 같은 곳에서 값을 받아 적는다** (`resolveTrip`). 여기서
 *    기본값을 따로 쓰면 "내일 출발" 이라고 적어놓고 다른 날로 여는 카드가 나온다.
 */
function tripText(resolved: ResolvedTrip): string {
  const { depart, back, adults } = resolved;
  const parts = [`${dayText(depart)} 출발`];
  if (back) parts.push(`${dayText(back)} 귀국`);
  else parts.push('편도');
  parts.push(`${adults}인`);
  return parts.join(' · ');
}

/**
 * 말한 인원을 우리가 줄였을 때.
 *
 * ⚠️ **말풍선을 새로 만들지 않는다.** 카드 + 고지 + 멘션 버튼이 이미 MAX_OUTPUTS(3)
 *    으로 꽉 차서 하나 더 얹으면 멘션 버튼이 조용히 잘린다. 기존 고지에 한 줄로 붙인다.
 */
function adultsClampedText(max: number): string {
  return `인원은 ${max}명까지만 넣을 수 있어 ${max}명으로 맞췄어요.`;
}

/** '2026-10-20' → '10월 20일'. 연도는 적지 않는다 — 카드 한 줄이 좁다. */
function dayText(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

/** ["4명", "9/22~24"] → '날짜·인원'. 무엇을 버렸는지 이름을 붙여준다. */
function conditionLabel(ignored: string[]): string {
  const labels: string[] = [];
  const joined = ignored.join(' ');
  if (/\d+\s*(월|일|\/)|내일|모레|주말|다음\s*주|다음주|담주|이번주|다음\s*달|다음달/.test(joined)) {
    labels.push('날짜');
  }
  if (/\d+\s*(명|인)/.test(joined)) labels.push('인원');
  // ⚠️ **"1박" 은 날짜가 아니라 가격 기준이다.** "1박 10만원 이하" 의 1박은 머무는
  //    기간이 아니라 **하루치 가격**을 말한다. 날짜로 분류하면 "날짜는 반영되지
  //    않았어요" 가 붙는데, 날짜를 반영하는 지금은 그게 거짓말이 된다.
  if (/만원|\d+\s*박/.test(joined)) labels.push('예산');
  // 동행·분위기. "아이랑" 을 '인원' 이라고 하면 틀린 이름이고, 이름이 틀리면
  // 사용자는 자기가 말한 것과 고지된 것을 못 잇는다.
  if (/아이|애기|애들|아기|가족|부모님|친구|연인|커플|혼자|야경|일몰|노을|실내|조용한|한적한|이색|힐링/.test(joined)) {
    labels.push('테마');
  }
  return labels.length ? labels.join('·') : '일부 조건';
}

/** 다른 사람이 먼저 같은 걸 물어 검색이 돌고 있는 경우. */
export function busyText(meta: SearchMeta, botName: string | null): t.Json {
  return t.simpleTextWithMention(
    `${withObjectParticle(subject(meta))} 먼저 찾고 있어요 🔍\n잠시 뒤 다시 물어봐 주세요!`,
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
  return t.simpleTextWithMention(
    `${withObjectParticle(subject(meta))} 찾고 있어요 🔍\n30초쯤 뒤에 다시 물어봐 주세요!`,
    botName,
  );
}

/**
 * 결과가 비었을 때.
 *
 * ⚠️ **"도시 이름을 다시 확인해주세요" 라고 하지 않는다.** 지역은 제대로 알아들었는데
 *    검색이 실패한 경우가 대부분이라, 그렇게 말하면 사용자는 자기가 틀린 줄 알고
 *    같은 질문을 다르게 쓰며 헤맨다. 원인이 다르면 문구도 달라야 한다.
 */
/**
 * 항공권 링크를 만들 수 없는 노선 ([airports.ts](../flight/airports.ts) routeProblem).
 *
 * ⚠️ "잠시 뒤 다시 물어봐 주세요" 라고 하지 않는다. 다시 물어도 같은 답이다 —
 *    무엇을 바꿔 말하면 되는지를 적는다.
 */
export function flightRouteText(problem: RouteProblem, botName: string | null): t.Json {
  let text: string;
  if (problem.kind === 'same') {
    text = problem.originAssumed
      ? `${problem.name} 출발 기준이라 출발지와 도착지가 같아요.\n` +
        `「부산에서 ${problem.name} 항공권」처럼 출발지를 같이 알려주세요.`
      : `출발지와 도착지가 같아요 (${problem.name}).\n` +
        `「부산에서 ${problem.name} 항공권」처럼 다시 알려주세요.`;
  } else if (problem.kind === 'no-origin-airport') {
    text = problem.isCountry
      ? `출발지가 나라(${problem.name})라서 공항을 정할 수 없어요.\n` +
        `「서울에서 ${problem.dest} 항공권」처럼 출발 도시를 알려주세요.`
      : `${problem.name}에는 공항이 없어 출발지로 쓸 수 없어요.\n` +
        `가까운 공항 도시를 출발지로 알려주세요. 예) 「서울에서 ${problem.dest} 항공권」`;
  } else {
    text =
      `${problem.name}에는 공항이 없어 항공권 링크를 만들 수 없어요.\n` +
      `가까운 공항이 있는 도시 이름으로 다시 물어봐 주세요.`;
  }
  return t.simpleTextWithMention(text, botName);
}

export function emptyText(meta: SearchMeta, botName: string | null): t.Json {
  // ⚠️ **빈 힌트를 템플릿에 끼워 넣지 마라.** 예전에는 `주세요. ${hint}` 였는데,
  //    힌트가 빈 문자열이면 문장 끝에 공백이 남았다.
  const hint = narrowerHint(meta);
  return t.simpleTextWithMention(
    `${subject(meta)} 정보를 지금은 정리하지 못했어요 🙏\n` +
      ['잠시 뒤 다시 물어봐 주세요.', hint].filter(Boolean).join(' '),
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
  return `${meta.placeName} ${KIND_LABEL[meta.kind]} 검색 결과 바로가기`;
}

/**
 * 그 줄이 왜 거기 있는지 한 줄로. **없으면 사용자는 이게 추천인 줄 안다.**
 *
 * 평소 카드는 "우리가 고른 다섯 곳" 인데 이건 "직접 보시라" 라서, 말 안 하면
 * 추천 품질이 갑자기 나빠진 것처럼 보인다.
 */
export const EMPTY_FALLBACK_NOTICE =
  '지금은 추천 목록을 정리하지 못해 검색 결과를 바로 열어드려요.';

/**
 * 검색을 **아예 할 수 없는 상태** (provider 에 키가 없다 등).
 *
 * ⚠️ "30초쯤 뒤에 다시 물어봐 주세요" 를 쓰면 안 된다. 결과가 영원히 안 오는데
 *    기다리게 하는 것이고, 사용자는 그 사이 같은 질문을 반복한다. 운영자에게는
 *    /health 의 openai 필드와 서버 로그가 신호다.
 */
export function unavailableText(meta: SearchMeta, botName: string | null): t.Json {
  return t.simpleTextWithMention(
    `지금은 ${subject(meta)} 검색이 안 되고 있어요 🙏\n고쳐두는 대로 다시 알려드릴게요.`,
    botName,
  );
}

/** 검색 자체가 실패했을 때 (모델 오류·타임아웃). */
export function failedText(meta: SearchMeta, botName: string | null): t.Json {
  return t.simpleTextWithMention(
    `${withObjectParticle(subject(meta))} 불러오지 못했어요 🙏\n잠시 뒤 다시 시도해 주세요.`,
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

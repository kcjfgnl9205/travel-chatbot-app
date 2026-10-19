/**
 * 사용자가 실제로 읽는 문구.
 *
 * [templates.ts](./templates.ts) 가 "카카오 JSON 을 어떻게 만드는가" 라면 여기는
 * **"무엇을 말하는가"** 다. 문구를 도메인 서비스마다 흩어두면 같은 상황에서 방마다
 * 다른 말이 나가고, 고지 문구처럼 빠지면 안 되는 줄이 조용히 사라진다.
 */

import * as t from './templates';
import { TripParams, resolveTrip } from '../flight/search-url';
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
    // 카드에 가격이 없으므로 "확정 운임이 아니다" 같은 고지는 할 말이 없다.
    lines.push(`링크는 ${tripText(tripType, opts.trip, opts.now)}으로 검색돼요.`);
  }

  // 출발지를 추측했으면 반드시 알려준다. 부산에서 가려던 사람이 고쳐 말할 유일한 단서다.
  if (opts.meta?.originAssumed && opts.meta.fromName) {
    lines.push(`${opts.meta.fromName} 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.`);
  }

  return lines.join('\n');
}

/**
 * '10월 20일 출발 · 24일 귀국 · 4인'.
 *
 * ⚠️ **링크를 만드는 함수와 같은 곳에서 값을 받아 적는다** (`resolveTrip`). 여기서
 *    기본값을 따로 쓰면 "내일 출발" 이라고 적어놓고 다른 날로 여는 카드가 나온다.
 */
function tripText(tripType: 'oneway' | 'round', trip: TripParams | null | undefined, now?: Date): string {
  const { depart, back, adults } = resolveTrip(tripType, trip, now ?? new Date());
  const parts = [`${dayText(depart)} 출발`];
  if (back) parts.push(`${dayText(back)} 귀국`);
  else parts.push('편도');
  parts.push(`${adults}인`);
  return parts.join(' · ');
}

/** '2026-10-20' → '10월 20일'. 연도는 적지 않는다 — 카드 한 줄이 좁다. */
function dayText(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

/** ["4명", "9/22~24"] → '날짜·인원'. 무엇을 버렸는지 이름을 붙여준다. */
function conditionLabel(ignored: string[]): string {
  const labels: string[] = [];
  const joined = ignored.join(' ');
  if (/\d+\s*(월|일|박|\/)|내일|모레|주말|다음\s*주|다음주|담주|이번주|다음\s*달|다음달/.test(joined)) {
    labels.push('날짜');
  }
  if (/\d+\s*(명|인)/.test(joined)) labels.push('인원');
  if (/만원/.test(joined)) labels.push('예산');
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
export function emptyText(meta: SearchMeta, botName: string | null): t.Json {
  return t.simpleTextWithMention(
    `${subject(meta)} 정보를 지금은 정리하지 못했어요 🙏\n` +
      `잠시 뒤 다시 물어봐 주세요. ${narrowerHint(meta)}`,
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
  // ⚠️ 예시에 **그 사람이 말한 도시를 끼워 넣지 않는다.** 동네 이름을 모르므로
  //    "오사카 신주쿠" 같은 없는 조합이 나간다. 고정 예시가 덜 똑똑해도 안 틀린다.
  return '동네 이름을 붙여 말해도 좋아요 (예: 도쿄 신주쿠).';
}

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

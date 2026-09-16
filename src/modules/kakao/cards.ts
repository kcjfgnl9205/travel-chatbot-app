/**
 * 사용자가 실제로 읽는 문구.
 *
 * [templates.ts](./templates.ts) 가 "카카오 JSON 을 어떻게 만드는가" 라면 여기는
 * **"무엇을 말하는가"** 다. 문구를 도메인 서비스마다 흩어두면 같은 상황에서 방마다
 * 다른 말이 나가고, 고지 문구처럼 빠지면 안 되는 줄이 조용히 사라진다.
 */

import * as t from './templates';
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
 * 퀵리플라이로 보여줄 **예시** 지역.
 *
 * 허용 목록이 아니다. 여기 없는 지역도 전부 검색된다 — "이런 걸 물어보면 된다"를
 * 보여주는 용도일 뿐이다.
 */
export const EXAMPLE_PLACES = ['오사카', '도쿄', '후쿠오카'] as const;

/** '오사카 호텔 추천해줘' 처럼 그대로 다시 보낼 수 있는 문장. */
export function exampleUtterance(place: string, kind: SearchKind): string {
  if (kind === 'flight') return `${place} 항공권 찾아줘`;
  return `${place} ${KIND_LABEL[kind]} 추천해줘`;
}

/** 예시 지역 퀵리플라이. 결과 카드에 붙어 "다음 질문"을 한 번의 탭으로 만든다. */
export function placeQuickReplies(kind: SearchKind, exclude?: string | null): t.Json[] {
  return EXAMPLE_PLACES.filter((place) => place !== exclude).map((place) =>
    t.quickReply(`${place} ${KIND_LABEL[kind]}`, exampleUtterance(place, kind)),
  );
}

/**
 * 도움말 카드.
 *
 * ⚠️ **"잘못된 검색입니다" 같은 오류 문구를 쓰지 않는다.** 봇을 멘션한 인사말·잡담까지
 *    오류로 취급하면 단톡방이 딱딱해진다. 할 수 있는 세 가지를 예시와 함께 보여주면
 *    그 자체가 안내가 된다 — 사용자는 틀렸다는 말 대신 다음에 뭘 물을지를 얻는다.
 */
export function helpCard(): t.Json {
  return t.listCard({
    headerTitle: '여행메이트가 도와드릴 수 있는 것',
    items: [
      t.listItem({ title: '🏨 호텔 찾기', description: '오사카 호텔 추천해줘' }),
      t.listItem({ title: '✈️ 항공권 찾기', description: '오사카 항공권 찾아줘' }),
      t.listItem({ title: '📍 관광지·맛집', description: '오사카 관광지 추천해줘' }),
    ],
    quickReplies: [
      t.quickReply('오사카 호텔', '오사카 호텔 추천해줘'),
      t.quickReply('오사카 항공권', '오사카 항공권 찾아줘'),
      t.quickReply('오사카 관광지', '오사카 관광지 추천해줘'),
    ],
  });
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
  cities: string[],
  botName: string | null,
): t.Json {
  // 도시를 못 구했으면(모델 실패) 일반 되묻기로 떨어진다 — 예시라도 주는 게 낫다.
  if (!cities.length) return askPlaceCard(kind);

  const label = KIND_LABEL[kind];

  // ⚠️ **퀵리플라이로 낸다. 카드가 아니다.**
  //    고르는 화면이지 읽는 화면이 아니다 — 도시 이름 하나면 고를 수 있고, 카드로
  //    만들면 줄 설명("관광지 보기")이 다섯 번 반복되며 자리만 차지한다.
  //    무엇보다 단톡방에서는 **눌러서 보내는 길**이 확실해야 한다. 사용자가 직접 치면
  //    멘션을 빼먹고, 멘션 없는 발화는 봇에게 아예 오지 않는다.
  //
  // 카카오 한계는 10개다. 마지막 한 자리는 "다른 도시" 가 쓴다.
  const ask: t.Json = {
    simpleText: {
      text: `${country} 어디로 가세요?\n도시를 고르면 ${withObjectParticle(label)} 찾아드릴게요.`,
    },
  };

  const outputs = [ask];
  const mention = mentionCard(botName);
  // ⚠️ **검증되지 않은 실험이다.** 별도 말풍선으로 내보내는 이유가 그것이다 —
  //    카카오가 모르는 action 을 거부해 이 말풍선이 통째로 안 보여도(itemCard 전례)
  //    위의 도시 목록은 그대로 나간다. 사용자는 아무것도 잃지 않는다.
  if (mention) outputs.push(mention);

  return t.skillResponse(outputs, [
    ...cities.map((city) => t.quickReply(`${city} ${label}`, exampleUtterance(city, kind))),
    // 목록에 없는 도시를 가려는 사람의 출구. 이게 없으면 고르거나 포기다.
    t.quickReply('다른 도시', `${label} 다른 도시`),
  ]);
}

/**
 * 입력창에 봇 멘션을 채워주는 카드. **문서에 없는 동작이라 실험 중이다.**
 *
 * 다른 봇(다비니)에서 "@OO에게 말하기" 를 누르면 전송 대신 입력창에 `@OO ` 이 채워지는
 * 것이 목격됐다. 그 동작을 내는 `talk_mention` 액션이 있다는 이야기가 있으나 **카카오
 * 공식 문서에는 없다** — 검색해도 우리 저장소 PR 말고는 나오지 않는다. 그래서
 * 문서화된 message 액션을 같이 실어 둘 중 하나는 걸리게 한다.
 *
 * 결과를 읽는 법 (팀톡방에서):
 *   · 버튼이 보이고 누르니 입력창에 `@봇이름 ` 이 채워진다 → 성공. 이 카드를 남긴다
 *   · 버튼이 보이는데 눌러도 그냥 전송된다 → message 로 동작한 것. 라벨만 바꾸면 된다
 *   · **이 말풍선만 통째로 안 보인다** → 카카오가 모르는 action 을 거부한 것. 지우면 된다
 */
export function mentionCard(botName: string | null): t.Json | null {
  if (!botName) return null;

  const full = `@${botName}에게 말하기`;
  const short = `@${botName}`;
  // 버튼 라벨은 14자다. 잘린 라벨은 무슨 버튼인지 알 수 없다.
  const label =
    full.length <= t.MAX_BUTTON_LABEL ? full : short.length <= t.MAX_BUTTON_LABEL ? short : '봇에게 말하기';

  return t.textCard({
    title: '목록에 없는 도시인가요?',
    description: '아래 버튼을 누른 뒤 도시 이름을 이어서 입력해 주세요.',
    buttons: [
      {
        label: t.cut(label, t.MAX_BUTTON_LABEL),
        action: 'talk_mention',
        // message 로도 동작하도록 같이 싣는다. 멘션 뒤 공백이 핵심이다 —
        // 입력창에 채워졌을 때 바로 이어 칠 수 있어야 한다.
        messageText: `@${botName} `,
        extra: { bot_name: botName },
      },
    ],
  });
}

/**
 * "다른 도시" 를 누른 사람에게. **다음 발화를 지명으로 받겠다는 약속이다.**
 *
 * ⚠️ 카카오에는 입력창을 미리 채우는 버튼이 없다. 버튼은 누르면 그 문장이 그대로
 *    전송될 뿐이라 `/호텔 ` 을 넣어줄 수 없다. 그래서 봇이 한 번 되묻고, 서버가
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
  //    서버로 온다. "도시 이름만 보내주세요" 라고만 하면 사용자는 "오사카" 라고 치고,
  //    아무 일도 일어나지 않는 화면을 보게 된다 — 실제로 그렇게 대화가 끊겼다.
  const how = botName
    ? `@${botName} 다낭 처럼 도시 이름을 보내주세요.`
    : '봇을 멘션하고 도시 이름을 보내주세요. 예) 다낭';

  // 퀵리플라이는 예시로 남겨둔다 — 되묻는 말만 있고 누를 게 없으면 대화가 끊긴다.
  return t.simpleText(`${where}\n${how}`, placeQuickReplies(kind));
}

/** 무엇을 묻는지는 알겠는데 지역이 없다. 되묻되 예시로 답을 쉽게 만든다. */
export function askPlaceCard(kind: SearchKind): t.Json {
  const label = KIND_LABEL[kind];
  return t.simpleText(
    `어느 지역 ${withObjectParticle(label)} 찾으세요?\n예) ${exampleUtterance('오사카', kind)}`,
    placeQuickReplies(kind),
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
export function noticeText(opts: { ignored?: string[]; meta?: SearchMeta }): string {
  const lines: string[] = [];

  const ignored = (opts.ignored ?? []).filter(Boolean);
  if (ignored.length) {
    lines.push(`${conditionLabel(ignored)}(${ignored.join(', ')})은 반영되지 않았어요.`);
  }

  // 출발지를 추측했으면 반드시 알려준다. 부산에서 가려던 사람이 고쳐 말할 유일한 단서다.
  if (opts.meta?.originAssumed && opts.meta.fromName) {
    lines.push(`${opts.meta.fromName} 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.`);
  }

  return lines.join('\n');
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
  return labels.length ? labels.join('·') : '일부 조건';
}

/** 다른 사람이 먼저 같은 걸 물어 검색이 돌고 있는 경우. */
export function busyText(meta: SearchMeta): t.Json {
  return t.simpleText(
    `${withObjectParticle(subject(meta))} 먼저 찾고 있어요 🔍\n잠시 뒤 다시 물어봐 주세요!`,
    placeQuickReplies(meta.kind, meta.placeName),
  );
}

/**
 * 콜백이 꺼져 있을 때의 미스 응답.
 *
 * 검색은 이미 백그라운드에서 돈다. 다시 물으면 저장된 결과가 바로 나간다 —
 * 콜백 없이 20초를 기다리게 할 방법이 없어서 둔 차선책이다.
 */
export function searchStartedText(meta: SearchMeta): t.Json {
  return t.simpleText(
    `${withObjectParticle(subject(meta))} 찾고 있어요 🔍\n30초쯤 뒤에 다시 물어봐 주세요!`,
    placeQuickReplies(meta.kind, meta.placeName),
  );
}

/**
 * 결과가 비었을 때.
 *
 * ⚠️ **"도시 이름을 다시 확인해주세요" 라고 하지 않는다.** 지역은 제대로 알아들었는데
 *    검색이 실패한 경우가 대부분이라, 그렇게 말하면 사용자는 자기가 틀린 줄 알고
 *    같은 질문을 다르게 쓰며 헤맨다. 원인이 다르면 문구도 달라야 한다.
 */
export function emptyText(meta: SearchMeta): t.Json {
  return t.simpleText(
    `${subject(meta)} 정보를 지금은 정리하지 못했어요 🙏\n잠시 뒤 다시 물어봐 주세요.`,
    placeQuickReplies(meta.kind, meta.placeName),
  );
}

/**
 * 검색을 **아예 할 수 없는 상태** (provider 에 키가 없다 등).
 *
 * ⚠️ "30초쯤 뒤에 다시 물어봐 주세요" 를 쓰면 안 된다. 결과가 영원히 안 오는데
 *    기다리게 하는 것이고, 사용자는 그 사이 같은 질문을 반복한다. 운영자에게는
 *    /health 의 openai 필드와 서버 로그가 신호다.
 */
export function unavailableText(meta: SearchMeta): t.Json {
  return t.simpleText(
    `지금은 ${subject(meta)} 검색이 안 되고 있어요 🙏
` + '고쳐두는 대로 다시 알려드릴게요.',
    placeQuickReplies(meta.kind, meta.placeName),
  );
}

/** 검색 자체가 실패했을 때 (모델 오류·타임아웃). */
export function failedText(meta: SearchMeta): t.Json {
  return t.simpleText(
    `${withObjectParticle(subject(meta))} 불러오지 못했어요 🙏\n잠시 뒤 다시 시도해 주세요.`,
    placeQuickReplies(meta.kind, meta.placeName),
  );
}

/** '오사카 호텔' / '서울→오사카 항공권'. 상황 문구가 공유하는 주어. */
export function subject(meta: SearchMeta): string {
  if (meta.kind === 'flight') {
    return `${meta.fromName ?? '서울'}→${meta.placeName} 항공권`;
  }
  return `${meta.placeName} ${KIND_LABEL[meta.kind]}`;
}

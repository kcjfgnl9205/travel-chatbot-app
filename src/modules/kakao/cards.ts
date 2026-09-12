/**
 * 사용자가 실제로 읽는 문구.
 *
 * [templates.ts](./templates.ts) 가 "카카오 JSON 을 어떻게 만드는가" 라면 여기는
 * **"무엇을 말하는가"** 다. 문구를 도메인 서비스마다 흩어두면 같은 상황에서 방마다
 * 다른 말이 나가고, 고지 문구처럼 빠지면 안 되는 줄이 조용히 사라진다.
 */

import * as t from './templates';
import { SearchKind, SearchMeta } from '../search/search.types';

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

/** 무엇을 묻는지는 알겠는데 지역이 없다. 되묻되 예시로 답을 쉽게 만든다. */
export function askPlaceCard(kind: SearchKind): t.Json {
  const label = KIND_LABEL[kind];
  return t.simpleText(
    `어느 지역 ${label}을 찾으세요?\n예) ${exampleUtterance('오사카', kind)}`,
    placeQuickReplies(kind),
  );
}

/**
 * 항상 붙는 고지.
 *
 * ⚠️ **이 줄을 빼면 안 된다.** 우리가 보여주는 건 실시간 재고·운임이 아니라 AI 가
 *    웹에서 정리한 값이다. 그 사실을 안 적으면 사용자는 카드 가격을 믿고 눌렀다가
 *    다른 금액을 본다.
 */
export const AI_NOTICE = 'AI가 정리한 참고 정보예요. 가격은 실제와 다를 수 있어요.';

/**
 * 카드 아래 안내 말풍선.
 *
 * ⚠️ **`ignored` 고지는 이 설계의 전제 조건이다.** 캐시를 지역으로만 가르기 때문에
 *    "9월 22~24일 4명" 을 말한 사람도 지역 기준 결과를 받는다. 그 날짜에 예약 불가한
 *    호텔과 다른 가격이 섞일 수밖에 없는데, 고지가 없으면 사용자는 속았다고 느낀다.
 */
export function noticeText(opts: {
  ignored?: string[];
  /** 캐시가 만료됐는데 새로 못 찾아 예전 결과를 보여주는 경우. */
  stale?: boolean;
  meta?: SearchMeta;
}): string {
  const lines = [AI_NOTICE];

  const ignored = (opts.ignored ?? []).filter(Boolean);
  if (ignored.length) {
    lines.push(`${conditionLabel(ignored)}(${ignored.join(', ')})은 반영되지 않았어요.`);
  }

  // 출발지를 추측했으면 반드시 알려준다. 부산에서 가려던 사람이 고쳐 말할 유일한 단서다.
  if (opts.meta?.originAssumed && opts.meta.fromName) {
    lines.push(`${opts.meta.fromName} 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.`);
  }

  if (opts.stale) lines.push('예전에 찾아둔 정보예요. 새로 찾는 중이니 잠시 뒤 다시 물어봐 주세요.');

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
    `${subject(meta)}을 먼저 찾고 있어요 🔍\n잠시 뒤 다시 물어봐 주세요!`,
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
    `${subject(meta)}을 찾고 있어요 🔍\n30초쯤 뒤에 다시 물어봐 주세요!`,
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
    `${subject(meta)}을 불러오지 못했어요 🙏\n잠시 뒤 다시 시도해 주세요.`,
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

/**
 * "더 보기" 페이지 넘김.
 *
 * listCard 는 5줄이 한계라 6번째부터는 보여줄 자리가 없다. 예전 버튼("다른 도시 보기")은
 * 도시가 빠진 문장을 보내서 되묻기로 떨어졌는데, 같은 자리에 **다음 5개**를 주는 게
 * 사용자가 실제로 원하는 것이다.
 *
 * ⚠️ **페이지를 넘기려면 넘길 것이 있어야 한다.** 예전에는 딱 5개만 검색해서 캐싱했다.
 *    이제 *_RESULT_LIMIT 만큼(기본 10) 찾아 캐시에 넣고, 카드에는 5줄씩 끊어서 낸다.
 *    검색 비용은 거의 그대로다 — 후보 수집(1차)은 어차피 15곳이었고, 2차가 더 많이
 *    고를 뿐이다. 대신 호텔 썸네일·관광지 사진은 10건을 받아오므로 그만큼 느려진다.
 *
 * 두 경로를 모두 받는다.
 *
 *   · **block** (권장) — 버튼이 `extra: { city, offset }` 를 실어 보내고 서버는
 *     `action.clientExtra` 로 받는다. 서버가 상태를 안 들고도 N 페이지가 된다.
 *   · **message** (우회) — 그룹챗방에서 `action: "block"` 이 되는지 확인되지 않았다.
 *     itemCard 가 그랬던 것처럼 안 될 수 있어서, 평범한 메시지 버튼도 지원한다.
 *     이 경로는 발화에 offset 을 실을 수 없으므로 **다음 한 페이지까지만** 간다.
 *     (3페이지 이상이 필요해지면 block 경로가 돼야 한다)
 */

import * as t from './templates';
import { KakaoSkillPayload, utteranceOf } from './dto/skill-payload.dto';

/** 한 카드에 담는 줄 수. listCard 의 한계가 곧 페이지 크기다. */
export const PAGE_SIZE = t.MAX_LIST_ITEMS;

/** "더 보기" / "더보기" / "다음" 을 알아본다. */
const MORE = /더\s*보기|다음\s*(페이지|것)?$/;

export type MoreButtonStyle = 'block' | 'message';

/**
 * 이번 요청이 보여줘야 할 시작 위치.
 *
 * clientExtra 가 있으면 그 값이 정답이다 — 카카오가 우리가 실어 보낸 걸 그대로 돌려준다.
 * 없는데 발화가 "더 보기" 면 우회 경로다. 그때는 다음 한 페이지로 본다.
 */
export function offsetOf(payload: KakaoSkillPayload): number {
  const raw = payload.action?.clientExtra?.offset;
  const fromExtra = Number(raw);
  if (Number.isFinite(fromExtra) && fromExtra > 0) return Math.floor(fromExtra);

  return isMoreRequest(utteranceOf(payload)) ? PAGE_SIZE : 0;
}

/** clientExtra 에 실려 온 도시. 발화에 도시가 없는 "호텔 더 보기" 를 살린다. */
export function cityFromExtra(payload: KakaoSkillPayload): string | null {
  const city = payload.action?.clientExtra?.city;
  if (typeof city !== 'string') return null;
  const trimmed = city.trim();
  return trimmed || null;
}

export function isMoreRequest(utterance: string): boolean {
  return MORE.test(utterance.trim());
}

/**
 * 카드 하단 "더 보기" 버튼. **다음 페이지가 남아 있을 때만 부른다.**
 *
 * 남은 게 없는데 버튼을 달면 눌러도 같은 5개가 다시 나오고, 사용자는 그걸
 * 고장으로 읽는다. 없으면 없는 게 낫다.
 */
export function moreButton(input: {
  style: MoreButtonStyle;
  blockId: string;
  /** '도쿄 호텔 더 보기' — block 경로에서도 이 문장이 사용자 발화로 남는다. */
  messageText: string;
  cityName: string;
  nextOffset: number;
}): t.Json {
  if (input.style === 'message' || !input.blockId) {
    return t.messageButton('더 보기', input.messageText);
  }
  return {
    label: '더 보기',
    action: 'block',
    blockId: input.blockId,
    messageText: input.messageText,
    extra: { city: input.cityName, offset: input.nextOffset },
  };
}

/**
 * 목록에서 이번 페이지만 잘라낸다.
 *
 * offset 이 목록을 넘어가면 빈 배열이 아니라 **마지막 페이지**를 준다.
 * 캐시가 만료돼 결과 수가 줄어든 사이에 "더 보기" 를 누르면 빈 카드가 나가는데,
 * 그건 사용자에게 고장으로 보인다.
 */
export function pageOf<T>(items: T[], offset: number): { page: T[]; start: number } {
  if (offset <= 0 || offset < items.length) {
    const start = Math.max(0, offset);
    return { page: items.slice(start, start + PAGE_SIZE), start };
  }
  const start = Math.max(0, (Math.ceil(items.length / PAGE_SIZE) - 1) * PAGE_SIZE);
  return { page: items.slice(start, start + PAGE_SIZE), start };
}

/** 다음 페이지가 남아 있는가. */
export function hasNextPage(total: number, start: number): boolean {
  return start + PAGE_SIZE < total;
}

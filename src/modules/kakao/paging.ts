/**
 * "더 보기" 페이지 넘김.
 *
 * 한 번의 AI 검색으로 20건을 찾아 **한 행에 통째로 저장**하고, listCard 가 5줄이므로
 * 5건씩 4페이지로 낸다. 2페이지를 보여주려고 AI 를 다시 부르지 않는다 —
 * 더보기는 **AI 호출 0회**가 전제다.
 *
 * 서버는 "누가 어디까지 봤는지" 를 기억하지 않는다. **버튼이 커서를 들고 다닌다.**
 *
 *   { label: '더 보기', action: 'block', blockId: <폴백 블록>,
 *     extra: { cache_key: 'hotel:123', offset: 5 } }
 *
 * ⚠️ 그룹챗방에서 `action: "block"` 이 동작하는지 **확인되지 않았다.** itemCard 가
 *    그랬던 것처럼 안 될 수 있어서 평범한 메시지 버튼(MORE_BUTTON_STYLE=message)도
 *    지원한다. 그 경로는 발화에 커서를 실을 수 없으므로 **서버가 발화자별 커서를
 *    짧게 기억한다** ([CursorMemory](#)).
 */

import * as t from './templates';
import { KakaoSkillPayload, utteranceOf } from './dto/skill-payload.dto';

/** 한 카드에 담는 줄 수. listCard 의 한계가 곧 페이지 크기다. */
export const PAGE_SIZE = t.MAX_LIST_ITEMS;

/** "더 보기" / "더보기" / "다음" 을 알아본다. */
const MORE = /더\s*보기|다음\s*(페이지|것)?$/;

export type MoreButtonStyle = 'block' | 'message';

export function isMoreRequest(utterance: string): boolean {
  return MORE.test(utterance.trim());
}

/** 버튼이 실어 보낸 캐시 키. 이게 있으면 AI 를 부르지 않고 저장된 행에서 잘라 보낸다. */
export function cacheKeyOf(payload: KakaoSkillPayload): string | null {
  const raw = payload.action?.clientExtra?.cache_key;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/** 버튼이 실어 보낸 시작 위치. 없으면 0. */
export function offsetOf(payload: KakaoSkillPayload): number {
  const raw = Number(payload.action?.clientExtra?.offset);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * 목록에서 이번 페이지만 잘라낸다.
 *
 * offset 이 목록을 넘어가면 빈 배열이 아니라 **마지막 페이지**를 준다. 캐시가 갱신돼
 * 결과 수가 줄어든 사이에 "더 보기" 를 누르면 빈 카드가 나가는데, 사용자에게 그건
 * 고장으로 보인다.
 */
export function pageOf<T>(items: T[], offset: number, maxItems: number): { page: T[]; start: number } {
  const capped = items.slice(0, maxItems);
  if (offset <= 0 || offset < capped.length) {
    const start = Math.max(0, offset);
    return { page: capped.slice(start, start + PAGE_SIZE), start };
  }
  const start = Math.max(0, (Math.ceil(capped.length / PAGE_SIZE) - 1) * PAGE_SIZE);
  return { page: capped.slice(start, start + PAGE_SIZE), start };
}

/** 다음 페이지가 남아 있는가. 없으면 버튼을 달지 않는다. */
export function hasNextPage(total: number, start: number, maxItems: number): boolean {
  return start + PAGE_SIZE < Math.min(total, maxItems);
}

/**
 * 카드 하단 "더 보기" 버튼. **다음 페이지가 남아 있을 때만 부른다.**
 *
 * 남은 게 없는데 버튼을 달면 눌러도 같은 5개가 다시 나오고, 사용자는 그걸 고장으로
 * 읽는다. 없으면 없는 게 낫다.
 */
export function moreButton(input: {
  style: MoreButtonStyle;
  blockId: string;
  /** '오사카 호텔 더 보기' — block 경로에서도 이 문장이 사용자 발화로 남는다. */
  messageText: string;
  cacheKey: string;
  nextOffset: number;
}): t.Json {
  if (input.style === 'message' || !input.blockId) {
    return t.messageButton('더 보기', input.messageText);
  }
  return t.blockButton({
    label: '더 보기',
    blockId: input.blockId,
    messageText: input.messageText,
    extra: { cache_key: input.cacheKey, offset: input.nextOffset },
  });
}

/**
 * 발화자별 커서. **`action: "block"` 이 안 될 때의 우회로다.**
 *
 * 메시지 버튼은 발화("오사카 호텔 더 보기")밖에 못 보낸다. 그 문장만으로는 어느
 * 페이지인지 알 수 없으므로, 카드를 보낸 쪽이 "이 사람에게 방금 0~4를 보여줬다"를
 * 잠깐 기억해둔다. 단톡방이라 **사람마다 따로** 들고 있어야 한다.
 *
 * 오래 들고 있을 필요는 없다. 더보기는 카드를 본 직후에 눌린다.
 */
const CURSOR_TTL_MS = 30 * 60_000;
const CURSOR_MAX_ENTRIES = 2000;

export interface Cursor {
  cacheKey: string;
  /** 다음에 보여줄 시작 위치. */
  offset: number;
}

export class CursorMemory {
  private readonly cursors = new Map<string, Cursor & { expiresAt: number }>();

  remember(userKey: string, cursor: Cursor): void {
    if (this.cursors.size >= CURSOR_MAX_ENTRIES) {
      // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
      const oldest = this.cursors.keys().next().value;
      if (oldest !== undefined) this.cursors.delete(oldest);
    }
    this.cursors.delete(userKey);
    this.cursors.set(userKey, { ...cursor, expiresAt: Date.now() + CURSOR_TTL_MS });
  }

  take(userKey: string): Cursor | null {
    const hit = this.cursors.get(userKey);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cursors.delete(userKey);
      return null;
    }
    return { cacheKey: hit.cacheKey, offset: hit.offset };
  }

  clear(): void {
    this.cursors.clear();
  }
}

/** 발화가 "더 보기" 인데 버튼이 커서를 안 실어 온 경우. 우회 경로를 타야 한다. */
export function needsCursorFallback(payload: KakaoSkillPayload): boolean {
  return !cacheKeyOf(payload) && isMoreRequest(utteranceOf(payload));
}

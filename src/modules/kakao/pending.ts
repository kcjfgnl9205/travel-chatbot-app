import { SearchKind } from '../search/search.types';

/**
 * "도시 이름만 보내주세요" 라고 해놓고 기다리는 상태.
 *
 * 카카오에는 **입력창을 미리 채우는 버튼이 없다.** 버튼은 누르면 그 문장이 그대로
 * 전송될 뿐이다. 그래서 "다른 도시" 를 누른 사람에게 `/호텔 ` 을 입력창에 넣어줄 수
 * 없고, 대신 **봇이 한 번 되묻고 다음 발화를 지명으로 받는다.**
 *
 *   [다른 도시] → "어느 도시 호텔을 찾으세요? 도시 이름만 보내주세요"
 *               → 사용자: "다낭"  → 다낭 호텔 검색
 *
 * ⚠️ **단톡방이라 사람마다 따로 들고 있어야 한다.** A 가 되묻기를 받은 상태에서
 *    B 가 "다낭" 이라고 말하면 그건 B 의 대답이 아니다.
 * ⚠️ **한 번 쓰면 버린다.** 남겨두면 한참 뒤의 잡담("부산 갈까?")이 검색으로 샌다.
 */
export interface PendingAsk {
  kind: SearchKind;
  /** 어느 나라에서 고르다 왔는지. 안내 문구에만 쓴다. */
  country: string | null;
}

/** 되묻고 기다리는 시간. 길게 잡으면 한참 뒤의 잡담을 지명으로 오인한다. */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2000;

export class PendingAskMemory {
  private readonly asks = new Map<string, PendingAsk & { expiresAt: number }>();

  remember(userKey: string, ask: PendingAsk): void {
    if (this.asks.size >= MAX_ENTRIES) {
      // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
      const oldest = this.asks.keys().next().value;
      if (oldest !== undefined) this.asks.delete(oldest);
    }
    this.asks.delete(userKey);
    this.asks.set(userKey, { ...ask, expiresAt: Date.now() + TTL_MS });
  }

  /** 꺼내면서 지운다. 한 번의 대답에만 쓴다. */
  take(userKey: string): PendingAsk | null {
    const hit = this.asks.get(userKey);
    if (!hit) return null;
    this.asks.delete(userKey);
    if (hit.expiresAt <= Date.now()) return null;
    return { kind: hit.kind, country: hit.country };
  }

  clear(): void {
    this.asks.clear();
  }
}

/** "다른 도시" 버튼이 보내는 발화. */
const ANOTHER = /다른\s*(도시|지역|곳)|직접\s*(입력|칠게|쓸게)/;

export function isAnotherPlaceRequest(utterance: string): boolean {
  return ANOTHER.test(utterance);
}

/**
 * 이 발화를 **지명 하나**로 봐도 되는가.
 *
 * 되묻기 직후에만 쓰는 판정이다. 그래도 느슨하면 "ㅋㅋㅋ" 이나 "몰라" 가 지명이 되어
 * places 테이블에 쌓이고 엉뚱한 검색이 돈다. 짧고, 한 덩어리이고, 문장부호·숫자가
 * 없을 때만 인정한다.
 */
export function looksLikePlaceName(utterance: string): boolean {
  const text = utterance.trim();
  if (!text || text.length > 12) return false;
  if (/[?？!！0-9]/.test(text)) return false;
  // "다낭", "나트랑", "뉴욕" 처럼 한 덩어리. "거기 어디였지" 같은 문장은 거른다.
  if (text.split(/\s+/).length > 2) return false;
  if (NOT_A_PLACE.has(text.replace(/\s+/g, ''))) return false;
  return /^[가-힣A-Za-z][가-힣A-Za-z\s]*$/.test(text);
}

/**
 * 짧고 한 덩어리지만 지명일 리 없는 말.
 *
 * 되묻기 직후라도 이런 대답은 온다 — 그걸 지명으로 받으면 places 에 "몰라" 가 지역으로
 * 박히고, 사용자는 자기가 왜 검색을 당했는지 모른다.
 */
const NOT_A_PLACE = new Set([
  '몰라', '모르겠어', '글쎄', '아무데나', '아무거나', '그냥', '아니', '아니요', '응', '어',
  '네', '예', '노', '됐어', '취소', '없어', '할래', '고마워', '감사', '알겠어', '오케이',
]);

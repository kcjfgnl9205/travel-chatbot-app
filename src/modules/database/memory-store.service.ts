import { Injectable } from '@nestjs/common';

/**
 * no-op(DB 없음) 모드에서 리다이렉트를 살려두기 위한 인메모리 폴백.
 *
 * Supabase 없이 로컬에서 챗봇을 띄워도 줄 클릭 → 애드픽 이동까지 돌아가게 한다.
 * 프로세스가 죽으면 사라지므로 개발 전용. 운영에서는 항상 DB 경로를 탄다.
 */
export interface ClickEntry {
  recommendationId: string | null;
  /** 노출 시점의 항목 이름 (호텔명·항공편). 로그에서 무엇을 눌렀는지 보려고 남긴다. */
  itemName: string;
  /** 변환의 입력이자 폴백 목적지. **클릭 시점에 여기서 커미션 링크를 만든다** (0015). */
  sourceUrl: string;
  /**
   * 변환을 못 했을 때 보낼 곳. 지금은 sourceUrl 과 같다.
   *
   * 칸을 남겨두는 이유는 변환하지 않는 줄(지도 주소 등)이 생겼을 때 그 줄만
   * 다른 목적지를 들 수 있어야 하기 때문이다.
   */
  targetUrl: string;
  /** 애드픽을 타는 줄인지 가리는 재료. 스카이스캐너는 광고주가 없다. */
  merchant: string | null;
  userId: string | null;
  clickCount: number;
}

const MAX_ENTRIES = 2000;

@Injectable()
export class MemoryStoreService {
  // Map 은 삽입 순서를 유지한다 → 가장 오래된 항목부터 버린다.
  private readonly clicks = new Map<string, ClickEntry>();

  put(clickId: string, entry: Omit<ClickEntry, 'clickCount'>): void {
    this.clicks.delete(clickId);
    this.clicks.set(clickId, { ...entry, clickCount: 0 });
    while (this.clicks.size > MAX_ENTRIES) {
      const oldest = this.clicks.keys().next().value;
      if (oldest === undefined) break;
      this.clicks.delete(oldest);
    }
  }

  /** DB 의 register_click() 과 같은 계약: 카운터를 올리고 항목을 돌려준다. */
  registerClick(clickId: string): ClickEntry | null {
    const entry = this.clicks.get(clickId);
    if (!entry) return null;
    entry.clickCount += 1;
    return entry;
  }

  get(clickId: string): ClickEntry | null {
    return this.clicks.get(clickId) ?? null;
  }

  clear(): void {
    this.clicks.clear();
  }
}

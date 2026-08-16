import { Injectable } from '@nestjs/common';

/**
 * no-op(DB 없음) 모드에서 리다이렉트를 살려두기 위한 인메모리 폴백.
 *
 * Supabase 없이 로컬에서 챗봇을 띄워도 줄 클릭 → 애드픽 이동까지 돌아가게 한다.
 * 프로세스가 죽으면 사라지므로 개발 전용. 운영에서는 항상 DB 경로를 탄다.
 */
export interface ClickEntry {
  recommendationId: string | null;
  hotelName: string;
  sourceUrl: string;
  targetUrl: string;
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

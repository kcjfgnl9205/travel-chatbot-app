import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 메모리 캐시 상한. 발화자 한 명당 한 칸이라 넉넉해도 가볍다.
 * (intent.service 와 같은 방식 — Map 은 삽입 순서를 지키므로 가장 오래된 것부터 버린다.)
 */
const MAX_ENTRIES = 5000;

@Injectable()
export class UsersRepository extends BaseRepository {
  protected readonly tableName = 'users';

  /**
   * `kakao_user_key` → 사용자 행.
   *
   * **같은 사람이 계속 말을 건다.** 단톡방에서 한 번 등록된 뒤로는 그 사람의 행이
   * 바뀔 일이 없는데, 예전에는 발화마다 users 를 조회했다. 그 왕복이 카카오 3.5초
   * 예산 안에 있었고, 더 중요하게는 **Supabase 처리량을 한 칸씩 먹었다** —
   * 요청당 왕복 7회 중 1회가 이것이다 ([LOADTEST.md](../../../../docs/LOADTEST.md)).
   */
  private readonly cache = new Map<string, Record<string, any>>();

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /** 카카오 botUserKey 로 사용자 upsert 후 행을 돌려준다. */
  async getOrCreate(kakaoUserKey: string): Promise<Record<string, any> | null> {
    const hit = this.cache.get(kakaoUserKey);
    if (hit) return hit;

    const existing = await this.runOne(
      (t) => t.select('*').eq('kakao_user_key', kakaoUserKey).limit(1),
      'select user',
    );
    if (existing) return this.remember(kakaoUserKey, existing);

    const created = await this.runOne(
      (t) =>
        t
          .upsert({ kakao_user_key: kakaoUserKey }, { onConflict: 'kakao_user_key' })
          .select('*'),
      'upsert user',
    );
    // ⚠️ **실패(null)는 캐시하지 않는다.** DB 가 1초 흔들린 것을 캐시에 굳히면
    //    그 사람은 프로세스가 사는 동안 영영 userId 없이 돈다 — 기록이 통째로 빈다.
    return created ? this.remember(kakaoUserKey, created) : null;
  }

  /** 테스트·운영 점검용. */
  clearMemory(): void {
    this.cache.clear();
  }

  private remember(key: string, row: Record<string, any>): Record<string, any> {
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, row);
    return row;
  }
}

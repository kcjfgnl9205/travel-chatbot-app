import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 같은 문장 재파싱 방지.
 *
 * 단톡방은 같은 말이 반복된다("오사카 호텔 추천해줘"). 발화 해석은 카카오 5초 예산
 * 안에서 도는 유료 호출이라, 두 번째부터 공짜가 되는 것이 곧 응답 속도이기도 하다.
 */
@Injectable()
export class IntentCacheRepository extends BaseRepository {
  protected readonly tableName = 'intent_cache';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /** 만료되지 않은 결과. 없으면 null. */
  async get(hash: string): Promise<unknown> {
    const row = await this.runOne(
      (t) => t.select('result, expires_at').eq('utterance_hash', hash).limit(1),
      'select intent cache',
    );
    if (!row) return null;

    const expires = Date.parse(String(row.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    return row.result ?? null;
  }

  async put(hash: string, result: unknown, ttlMinutes: number): Promise<void> {
    await this.run(
      (t) =>
        t
          .upsert(
            {
              utterance_hash: hash,
              result,
              expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
            },
            { onConflict: 'utterance_hash' },
          )
          .select('utterance_hash'),
      'upsert intent cache',
    );
  }
}

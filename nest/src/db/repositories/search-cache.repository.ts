import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

export interface PutCacheInput {
  cacheKey: string;
  domain: string;
  provider: string;
  payload: unknown[];
  ttlMinutes: number;
}

/**
 * 검색 결과(호텔 목록) 캐시.
 *
 * AI/크롤링 provider 가 붙으면 이게 비용과 응답 속도를 동시에 좌우한다.
 */
@Injectable()
export class SearchCacheRepository extends BaseRepository {
  protected readonly tableName = 'search_cache';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /** 만료되지 않은 캐시 행. 없으면 null. */
  async get(cacheKey: string): Promise<Record<string, any> | null> {
    const row = await this.runOne(
      (t) =>
        t
          .select('id, payload, item_count, hit_count, expires_at')
          .eq('cache_key', cacheKey)
          .limit(1),
      'select search cache',
    );
    if (!row) return null;

    const expires = Date.parse(String(row.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    return row;
  }

  async put(input: PutCacheInput): Promise<void> {
    const record = {
      cache_key: input.cacheKey,
      domain: input.domain,
      provider: input.provider,
      payload: input.payload,
      item_count: input.payload.length,
      hit_count: 0,
      expires_at: new Date(Date.now() + input.ttlMinutes * 60_000).toISOString(),
    };
    await this.run(
      (t) => t.upsert(record, { onConflict: 'cache_key' }).select('id'),
      'upsert search cache',
    );
  }

  /** 재사용 횟수. 아낀 provider 호출 수를 나중에 세기 위한 것. */
  async markHit(cacheId: string, hitCount: number): Promise<void> {
    await this.run(
      (t) => t.update({ hit_count: hitCount + 1 }).eq('id', cacheId).select('id'),
      'bump search cache hit',
    );
  }
}

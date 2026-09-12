import { Injectable } from '@nestjs/common';

import { SearchKind, SearchMeta, SearchRow, TripType } from '../../search/search.types';
import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 검색 결과 저장 겸 캐시 겸 **동시 호출 방지 락**.
 *
 * 캐시가 빈 상태에서 세 명이 동시에 "오사카 호텔" 을 치면 AI 가 세 번 돈다.
 * 행을 pending 으로 **먼저 꽂은 쪽만** 검색을 수행하게 하면 Redis 락 없이
 * Postgres 만으로 한 번으로 묶인다.
 *
 *   insert ... on conflict (cache_key) do nothing returning cache_key
 *
 * PostgREST 에는 그 구문이 없지만 `upsert(..., { ignoreDuplicates: true })` 가
 * 정확히 같은 SQL 로 번역된다 — 그래서 **돌려받은 행이 있으면 내가 선점한 것**이다.
 */
export interface ClaimInput {
  cacheKey: string;
  kind: SearchKind;
  placeId: number | null;
  fromPlaceId: number | null;
  toPlaceId: number | null;
  tripType: TripType | null;
  meta: SearchMeta;
}

@Injectable()
export class SearchResultsRepository extends BaseRepository {
  protected readonly tableName = 'search_results';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async get(cacheKey: string): Promise<SearchRow | null> {
    const row = await this.runOne(
      (t) => t.select(COLUMNS).eq('cache_key', cacheKey).limit(1),
      'select search result',
    );
    return row ? toRow(row) : null;
  }

  /** 새 행을 pending 으로 꽂는다. **돌려받으면 내가 검색할 차례다.** */
  async claim(input: ClaimInput): Promise<boolean> {
    const rows = await this.run(
      (t) =>
        t
          .upsert(
            {
              cache_key: input.cacheKey,
              kind: input.kind,
              place_id: input.placeId,
              from_place_id: input.fromPlaceId,
              to_place_id: input.toPlaceId,
              trip_type: input.tripType,
              status: 'pending',
              meta: input.meta,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'cache_key', ignoreDuplicates: true },
          )
          .select('cache_key'),
      'claim search result',
    );
    return Boolean(rows?.length);
  }

  /**
   * 이미 있는 행을 다시 pending 으로 돌린다 (만료·실패·버려진 pending).
   *
   * `updated_at` 이 내가 본 값 그대로일 때만 성공한다 — 두 요청이 같은 만료 행을
   * 동시에 보면 한쪽만 이겨야 AI 호출이 한 번으로 끝난다.
   */
  async reclaim(cacheKey: string, seenUpdatedAt: string | null): Promise<boolean> {
    if (!seenUpdatedAt) return false;
    const rows = await this.run(
      (t) =>
        t
          .update({ status: 'pending', error: null, updated_at: new Date().toISOString() })
          .eq('cache_key', cacheKey)
          .eq('updated_at', seenUpdatedAt)
          .select('cache_key'),
      'reclaim search result',
    );
    return Boolean(rows?.length);
  }

  async complete(
    cacheKey: string,
    items: unknown[],
    ttlMinutes: number,
    meta: SearchMeta,
  ): Promise<void> {
    const now = new Date();
    await this.run(
      (t) =>
        t
          .update({
            status: 'ready',
            items,
            item_count: items.length,
            meta,
            error: null,
            fetched_at: now.toISOString(),
            expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('cache_key', cacheKey)
          .select('cache_key'),
      'complete search result',
    );
  }

  /**
   * 실패를 기록한다. **항목은 지우지 않는다** — 예전에 찾아둔 결과가 있으면
   * "예전 정보예요" 로 보여주는 편이 아무것도 못 주는 것보다 낫다.
   */
  async fail(cacheKey: string, error: string, ttlMinutes: number): Promise<void> {
    const now = new Date();
    await this.run(
      (t) =>
        t
          .update({
            status: 'failed',
            error: error.slice(0, 500),
            expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('cache_key', cacheKey)
          .select('cache_key'),
      'fail search result',
    );
  }
}

const COLUMNS =
  'cache_key, kind, status, items, item_count, meta, error, fetched_at, expires_at, updated_at';

function toRow(row: Record<string, any>): SearchRow {
  return {
    cacheKey: String(row.cache_key),
    kind: row.kind as SearchKind,
    status: (row.status ?? 'pending') as SearchRow['status'],
    items: Array.isArray(row.items) ? row.items : [],
    meta: (row.meta ?? {}) as SearchMeta,
    error: row.error ?? null,
    fetchedAt: millis(row.fetched_at),
    expiresAt: millis(row.expires_at),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

function millis(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

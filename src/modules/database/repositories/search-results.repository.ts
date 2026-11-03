import { Injectable } from '@nestjs/common';

import { SearchKind, SearchMeta, SearchRow, TripType } from '../../search/search.types';
import { MysqlService } from '../mysql.service';
import { SearchResultRow } from '../rows.types';
import { BaseRepository } from './base.repository';

/**
 * 검색 결과 저장 겸 캐시 겸 **동시 호출 방지 락**.
 *
 * 캐시가 빈 상태에서 세 명이 동시에 "오사카 호텔" 을 치면 AI 가 세 번 돈다.
 * 행을 pending 으로 **먼저 꽂은 쪽만** 검색을 수행하게 하면 Redis 락 없이
 * DB 만으로 한 번으로 묶인다.
 *
 *   insert ... on duplicate key update cache_key = cache_key
 *
 * 새로 들어가면 affectedRows 1, 이미 있으면 0 — **1 이면 내가 선점한 것**이다.
 * (mysql.service.ts 가 FOUND_ROWS 를 끈 이유가 이것이다. 켜져 있으면 둘 다 1 이 된다.)
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

  constructor(db: MysqlService) {
    super(db);
  }

  /**
   * 만료된 행을 **실제로 지운다.**
   *
   * ⚠️ 기본 동작은 정반대다 — 0004 는 "만료돼도 지우지 않는다" 로 두었다. AI 검색이
   *    실패했을 때 예전 값이라도 보여주려는 것이고, 호텔·항공권에는 그게 맞다.
   *
   * ⚠️ **관광지에는 이제 쓰지 않는다.** 0008 시절에는 그 행에 구글 콘텐츠가 들어
   *    있어서 약관 때문에 실제로 지워야 했는데, 0009 부터 관광지 목록은 우리 DB 에서
   *    오므로 보관 제한이 없다. 지금 이 함수를 부르는 건 호텔·항공권뿐이다.
   */
  async purgeExpired(kind: string): Promise<number | null> {
    const result = await this.execute(
      'DELETE FROM search_results WHERE kind = ? AND expires_at < UTC_TIMESTAMP(3)',
      [kind],
      'purge expired',
    );
    return result ? result.affectedRows : null;
  }

  async get(cacheKey: string): Promise<SearchRow | null> {
    const row = await this.selectOne<SearchResultRow>(
      `SELECT ${COLUMNS} FROM search_results WHERE cache_key = ? LIMIT 1`,
      [cacheKey],
      'select search result',
    );
    return row ? toRow(row) : null;
  }

  /**
   * 새 행을 pending 으로 꽂는다. **돌려받으면 내가 검색할 차례다.**
   *
   * @returns true 선점 성공 · false 남이 먼저 꽂았다 · **null 은 DB 를 못 믿는다**
   *          (테이블이 없거나 DB 가 흔들림). 셋을 구분해야 하는 이유는
   *          null 을 false 로 뭉개면 **아무도 검색을 못 하게 되기** 때문이다 —
   *          0004 마이그레이션을 안 돌린 서버가 "먼저 찾고 있어요" 만 반복한다.
   */
  async claim(input: ClaimInput): Promise<boolean | null> {
    const { sql, params } = this.insertSql(
      [
        {
          cache_key: input.cacheKey,
          kind: input.kind,
          place_id: input.placeId,
          from_place_id: input.fromPlaceId,
          to_place_id: input.toPlaceId,
          trip_type: input.tripType,
          status: 'pending',
          meta: input.meta,
          updated_at: new Date(),
        },
      ],
      'ignore',
    );
    const result = await this.execute(sql, params, 'claim search result');
    // execute() 는 실패하면 null, 충돌로 아무것도 안 꽂혔으면 affectedRows 0 을 준다. 둘은 다르다.
    return result === null ? null : result.affectedRows > 0;
  }

  /**
   * 이미 있는 행을 다시 pending 으로 돌린다 (만료·실패·버려진 pending).
   *
   * `updated_at` 이 내가 본 값 그대로일 때만 성공한다 — 두 요청이 같은 만료 행을
   * 동시에 보면 한쪽만 이겨야 AI 호출이 한 번으로 끝난다.
   */
  async reclaim(cacheKey: string, seenUpdatedAt: string | null): Promise<boolean | null> {
    if (!seenUpdatedAt) return false;
    const result = await this.execute(
      `UPDATE search_results
          SET status = 'pending', error = NULL, updated_at = ?
        WHERE cache_key = ? AND updated_at = ?`,
      [new Date(), cacheKey, new Date(seenUpdatedAt)],
      'reclaim search result',
    );
    return result === null ? null : result.affectedRows > 0;
  }

  async complete(
    cacheKey: string,
    items: unknown[],
    ttlMinutes: number,
    meta: SearchMeta,
  ): Promise<void> {
    const now = new Date();
    const set = this.setSql({
      status: 'ready',
      items,
      item_count: items.length,
      meta,
      error: null,
      fetched_at: now,
      expires_at: new Date(now.getTime() + ttlMinutes * 60_000),
      updated_at: now,
    });
    await this.execute(
      `UPDATE search_results SET ${set.sql} WHERE cache_key = ?`,
      [...set.params, cacheKey],
      'complete search result',
    );
  }

  /**
   * 실패를 기록한다. **항목은 지우지 않는다** — 예전에 찾아둔 결과가 있으면
   * "예전 정보예요" 로 보여주는 편이 아무것도 못 주는 것보다 낫다.
   */
  async fail(cacheKey: string, error: string, ttlMinutes: number): Promise<void> {
    const now = new Date();
    await this.execute(
      `UPDATE search_results
          SET status = 'failed', error = ?, expires_at = ?, updated_at = ?
        WHERE cache_key = ?`,
      [error.slice(0, 500), new Date(now.getTime() + ttlMinutes * 60_000), now, cacheKey],
      'fail search result',
    );
  }
}

const COLUMNS =
  'cache_key, kind, status, items, item_count, meta, error, fetched_at, expires_at, updated_at';

function toRow(row: SearchResultRow): SearchRow {
  return {
    cacheKey: String(row.cache_key),
    kind: row.kind,
    status: (row.status ?? 'pending'),
    items: Array.isArray(row.items) ? row.items : [],
    meta: (row.meta ?? {}) as unknown as SearchMeta,
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

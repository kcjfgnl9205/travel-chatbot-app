import { Injectable } from '@nestjs/common';

import { MysqlService } from '../mysql.service';
import { RecommendationItemRow } from '../rows.types';
import { BaseRepository } from './base.repository';

export interface CreateRecommendationInput {
  /** 행 id 를 호출부가 정한다. 비우면 여기서 만든다 ([messages](./messages.repository.ts) 와 같은 이유). */
  id?: string;
  userId: string | null;
  messageId: string | null;
  domain: string;
  citySlug: string | null;
  provider: string;
  itemCount: number;
  guests?: number | null;
  latencyMs?: number | null;
  cacheHit?: boolean;
}

/** register_click 이 돌려주는 칸. 리다이렉트가 이걸로 목적지를 정한다. */
export type ClickedItem = Pick<
  RecommendationItemRow,
  'target_url' | 'source_url' | 'merchant' | 'recommendation_id' | 'item_name' | 'click_count'
>;

@Injectable()
export class RecommendationsRepository extends BaseRepository {
  protected readonly tableName = 'recommendations';

  constructor(db: MysqlService) {
    super(db);
  }

  async create(input: CreateRecommendationInput): Promise<{ id: string } | null> {
    const id = input.id ?? crypto.randomUUID();
    const { sql, params } = this.insertSql([
      {
        id,
        user_id: input.userId,
        message_id: input.messageId,
        domain: input.domain,
        city_slug: input.citySlug,
        provider: input.provider,
        item_count: input.itemCount,
        guests: input.guests ?? null,
        latency_ms: input.latencyMs ?? null,
        cache_hit: input.cacheHit ?? false,
      },
    ]);
    return (await this.execute(sql, params, 'insert recommendation')) ? { id } : null;
  }
}

@Injectable()
export class RecommendationItemsRepository extends BaseRepository {
  protected readonly tableName = 'recommendation_items';

  constructor(db: MysqlService) {
    super(db);
  }

  async createMany(items: Record<string, unknown>[]): Promise<{ id: string }[] | null> {
    if (!items.length) return [];
    const rows = items.map((item) => ({ id: crypto.randomUUID(), ...item }));
    const { sql, params } = this.insertSql(rows);
    if (!(await this.execute(sql, params, 'insert rec items'))) return null;
    return rows.map((r) => ({ id: String(r.id) }));
  }

  /**
   * 클릭 1회를 기록하고 리다이렉트 목적지를 돌려준다.
   *
   * 조회 + 카운터 증가 + 목적지 반환을 **한 트랜잭션**에서 처리한다 (Postgres 시절의
   * register_click() 함수와 같은 계약). 없는 clickId 면 null.
   */
  async registerClick(clickId: string): Promise<ClickedItem | null> {
    return this.transaction('register_click', async (tx) => {
      const bumped = await tx.execute(
        `UPDATE recommendation_items
            SET click_count      = click_count + 1,
                first_clicked_at = COALESCE(first_clicked_at, UTC_TIMESTAMP(3)),
                last_clicked_at  = UTC_TIMESTAMP(3)
          WHERE click_id = ?`,
        [clickId],
      );
      if (!bumped.affectedRows) return null;
      const rows = await tx.select<ClickedItem>(
        `SELECT target_url, source_url, merchant, recommendation_id, item_name, click_count
           FROM recommendation_items
          WHERE click_id = ?`,
        [clickId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * 클릭 시점에 만든 커미션 링크를 그 줄에 달아둔다 (0015).
   *
   * **사용자를 보낸 뒤에 부른다.** 여기서 실패해도 사용자는 이미 목적지에 있고,
   * 잃는 것은 집계 한 칸이다. 그것 때문에 302 를 붙잡을 이유가 없다.
   */
  async attachAffiliateLink(clickId: string, affiliateLinkId: string): Promise<void> {
    await this.execute(
      'UPDATE recommendation_items SET affiliate_link_id = ? WHERE click_id = ?',
      [affiliateLinkId, clickId],
      'attach affiliate link',
    );
  }
}

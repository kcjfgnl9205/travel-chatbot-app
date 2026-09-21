import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

export interface CreateRecommendationInput {
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

@Injectable()
export class RecommendationsRepository extends BaseRepository {
  protected readonly tableName = 'recommendations';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async create(input: CreateRecommendationInput): Promise<Record<string, any> | null> {
    const record = {
      user_id: input.userId,
      message_id: input.messageId,
      domain: input.domain,
      city_slug: input.citySlug,
      provider: input.provider,
      item_count: input.itemCount,
      guests: input.guests ?? null,
      latency_ms: input.latencyMs ?? null,
      cache_hit: input.cacheHit ?? false,
    };
    return this.runOne((t) => t.insert(record).select('id'), 'insert recommendation');
  }
}

@Injectable()
export class RecommendationItemsRepository extends BaseRepository {
  protected readonly tableName = 'recommendation_items';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async createMany(items: Record<string, unknown>[]): Promise<Record<string, any>[] | null> {
    if (!items.length) return [];
    return this.run((t) => t.insert(items).select('id'), 'insert rec items');
  }

  /**
   * 도메인별 위성 테이블에 상세를 남긴다 (recommendation_item_attractions 등).
   *
   * 공통 행이 먼저 들어가 있어야 한다 — item_id 가 그 행을 가리키는 외래키다.
   * 실패해도 예외를 올리지 않는 건 다른 기록과 같다. 상세가 빠져도 노출·클릭은
   * 이미 공통 테이블에 남아 있으므로 잃는 건 분석용 값뿐이다.
   */
  async createDetails(
    tableName: string,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, any>[] | null> {
    if (!rows.length) return [];
    return this.runOn(tableName, (t) => t.insert(rows).select('item_id'), `insert ${tableName}`);
  }

  /**
   * 클릭 1회를 기록하고 리다이렉트 목적지를 돌려준다.
   *
   * 조회 + 카운터 증가 + 목적지 반환을 DB 왕복 **한 번**에 처리한다.
   * 사용자가 302 를 기다리는 경로라 왕복 수가 곧 체감 지연이다.
   * 없는 clickId 면 빈 결과 → null.
   */
  async registerClick(clickId: string): Promise<Record<string, any> | null> {
    const rows = await this.rpc('register_click', { p_click_id: clickId }, 'register_click');
    return rows && rows.length ? rows[0] : null;
  }
}

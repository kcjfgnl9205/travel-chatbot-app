import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 원본 호텔 주소 → 애드픽 커미션 링크 변환 캐시.
 *
 * 같은 호텔을 매번 애드픽 API 로 변환하면 카카오 5초 예산을 넘긴다.
 * 한 번 변환한 주소는 여기서 재사용한다.
 */
@Injectable()
export class AffiliateLinksRepository extends BaseRepository {
  protected readonly tableName = 'affiliate_links';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /** 재사용 가능한(status=ok, 미만료) 변환 결과를 source_url 로 인덱싱해 돌려준다. */
  async findUsable(sourceUrls: string[]): Promise<Map<string, Record<string, any>>> {
    const usable = new Map<string, Record<string, any>>();
    if (!sourceUrls.length) return usable;

    const rows = await this.run(
      (t) =>
        t
          .select('id, source_url, affiliate_url, status, expires_at')
          .in('source_url', sourceUrls)
          .eq('status', 'ok'),
      'select affiliate links',
    );

    const now = Date.now();
    for (const row of rows ?? []) {
      if (!row.affiliate_url) continue;
      if (isExpired(row.expires_at, now)) continue;
      usable.set(row.source_url, row);
    }
    return usable;
  }

  /** 변환 결과를 저장하고 source_url → 행 매핑을 돌려준다. */
  async upsertMany(
    links: Record<string, unknown>[],
    ttlDays: number,
  ): Promise<Map<string, Record<string, any>>> {
    const saved = new Map<string, Record<string, any>>();
    if (!links.length) return saved;

    const expiresAt =
      ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;

    const rows = links.map((l) => ({
      ...l,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }));

    const result = await this.run(
      (t) => t.upsert(rows, { onConflict: 'partner,source_url' }).select('*'),
      'upsert affiliate links',
    );
    for (const row of result ?? []) {
      if (row.source_url) saved.set(row.source_url, row);
    }
    return saved;
  }
}

function isExpired(expiresAt: unknown, now: number): boolean {
  if (!expiresAt) return false; // null = 무기한
  const t = Date.parse(String(expiresAt));
  return Number.isFinite(t) ? t <= now : false;
}

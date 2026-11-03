import { Injectable } from '@nestjs/common';

import { MysqlService } from '../mysql.service';
import { AffiliateLinkRow } from '../rows.types';
import { BaseRepository } from './base.repository';

/**
 * 원본 호텔 주소 → 애드픽 커미션 링크 변환 캐시.
 *
 * 같은 호텔을 매번 애드픽 API 로 변환하면 카카오 5초 예산을 넘긴다.
 * 한 번 변환한 주소는 여기서 재사용한다.
 *
 * ⚠️ source_url 은 TEXT 라 유니크를 직접 못 건다. `source_url_hash`(SHA-256, 생성 컬럼)가
 *    그 역할을 하므로 **조회도 해시로 한다** — 그래야 인덱스를 탄다.
 */
@Injectable()
export class AffiliateLinksRepository extends BaseRepository {
  protected readonly tableName = 'affiliate_links';

  constructor(db: MysqlService) {
    super(db);
  }

  /** 재사용 가능한(status=ok, 미만료) 변환 결과를 source_url 로 인덱싱해 돌려준다. */
  async findUsable(sourceUrls: string[]): Promise<Map<string, UsableLink>> {
    const usable = new Map<string, UsableLink>();
    if (!sourceUrls.length) return usable;

    const rows = await this.select<AffiliateLinkRow>(
      `SELECT id, source_url, affiliate_url, status, expires_at
         FROM affiliate_links
        WHERE source_url_hash IN (${hashes(sourceUrls)})
          AND status = 'ok'`,
      sourceUrls,
      'select affiliate links',
    );

    const now = Date.now();
    for (const row of rows ?? []) {
      if (!row.affiliate_url) continue;
      if (isExpired(row.expires_at, now)) continue;
      usable.set(row.source_url, { ...row, affiliate_url: row.affiliate_url });
    }
    return usable;
  }

  /** 변환 결과를 저장하고 source_url → 행 매핑을 돌려준다. */
  async upsertMany(
    links: Record<string, unknown>[],
    ttlDays: number,
  ): Promise<Map<string, AffiliateLinkRow>> {
    const saved = new Map<string, AffiliateLinkRow>();
    if (!links.length) return saved;

    const expiresAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000) : null;
    const rows: Record<string, unknown>[] = links.map((l) => ({
      // 새 행일 때만 쓰인다. 이미 있으면 id 는 그대로 남는다(아래 update 목록에 없다).
      id: crypto.randomUUID(),
      ...l,
      expires_at: expiresAt,
      updated_at: new Date(),
    }));
    const update = Object.keys(rows[0]).filter((c) => c !== 'id' && c !== 'partner' && c !== 'source_url');

    const { sql, params } = this.insertSql(rows, { update });
    if (!(await this.execute(sql, params, 'upsert affiliate links'))) return saved;

    // RETURNING 이 없어서 다시 읽는다. 해시 인덱스라 한 번이면 된다.
    const urls = rows.map((r) => String(r.source_url));
    const result = await this.select<AffiliateLinkRow>(
      `SELECT ${COLUMNS} FROM affiliate_links WHERE source_url_hash IN (${hashes(urls)})`,
      urls,
      'select upserted affiliate links',
    );
    for (const row of result ?? []) {
      if (row.source_url) saved.set(row.source_url, row);
    }
    return saved;
  }
}

/** 재사용해도 되는 링크 — 커미션 링크가 반드시 있다. */
export type UsableLink = AffiliateLinkRow & { affiliate_url: string };

const COLUMNS = [
  'id', 'partner', 'merchant', 'source_url', 'affiliate_url', 'p_data', 'merchant_name',
  'commission_per', 'status', 'error', 'raw_response', 'converted_at', 'expires_at',
  'created_at', 'updated_at',
].join(', ');

/** `UNHEX(SHA2(?, 256))` 를 url 수만큼. 생성 컬럼 정의와 같은 식이어야 한다. */
function hashes(urls: string[]): string {
  return urls.map(() => 'UNHEX(SHA2(?, 256))').join(', ');
}

function isExpired(expiresAt: unknown, now: number): boolean {
  if (!expiresAt) return false; // null = 무기한
  const t = Date.parse(String(expiresAt));
  return Number.isFinite(t) ? t <= now : false;
}

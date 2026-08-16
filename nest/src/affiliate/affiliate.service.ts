import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AdpickService,
  LinkResult,
  STATUS_OK,
  linkOk,
} from '../adpick/adpick.service';
import { AppConfig, CONFIG } from '../config/configuration';
import { AffiliateLinksRepository } from '../db/repositories/affiliate-links.repository';

/**
 * 제휴 링크 해석: 캐시 조회 → 없으면 애드픽 변환 → 캐시 저장.
 *
 * 카카오 5초 예산 안에서 돌아야 하므로
 *   - 캐시 히트는 DB 조회 1번으로 끝내고
 *   - 미스만 동시에 변환한다.
 */
export interface ResolvedLink {
  sourceUrl: string;
  affiliateUrl: string;
  affiliateLinkId: string | null;
  status: string;
  fromCache: boolean;
}

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repo: AffiliateLinksRepository,
    private readonly adpick: AdpickService,
  ) {}

  /** [(sourceUrl, merchant), ...] → Map<sourceUrl, ResolvedLink> */
  async resolve(
    targets: { sourceUrl: string; merchant?: string | null }[],
  ): Promise<Map<string, ResolvedLink>> {
    const wanted = new Map<string, string | null>();
    for (const t of targets) {
      if (t.sourceUrl && !wanted.has(t.sourceUrl)) {
        wanted.set(t.sourceUrl, t.merchant ?? null);
      }
    }

    const resolved = new Map<string, ResolvedLink>();
    if (!wanted.size) return resolved;

    const cached = await this.repo.findUsable([...wanted.keys()]);
    for (const [url, row] of cached) {
      resolved.set(url, {
        sourceUrl: url,
        affiliateUrl: row.affiliate_url,
        affiliateLinkId: row.id ?? null,
        status: STATUS_OK,
        fromCache: true,
      });
    }

    const misses = [...wanted.keys()].filter((u) => !resolved.has(u));
    if (!misses.length) return resolved;

    const results: LinkResult[] = await Promise.all(
      misses.map((url) => this.adpick.convert(url, wanted.get(url))),
    );

    // 변환에 성공했든 폴백이든 기록해둔다. 실패 이유를 나중에 봐야 하므로.
    const rows = results.map((r) => ({
      partner: 'adpick',
      merchant: wanted.get(r.sourceUrl) ?? null,
      source_url: r.sourceUrl,
      affiliate_url: r.affiliateUrl,
      p_data: r.pData ?? null,
      merchant_name: r.merchantName ?? null,
      commission_per: r.commissionPer ?? null,
      status: r.status,
      error: r.error ?? null,
      raw_response: r.raw ?? null,
      converted_at: r.status === STATUS_OK ? new Date().toISOString() : null,
    }));
    const saved = await this.repo.upsertMany(rows, this.config.adpickLinkTtlDays);

    for (const result of results) {
      if (!linkOk(result)) {
        this.logger.warn(
          `affiliate link unresolved url=${result.sourceUrl} status=${result.status} err=${result.error}`,
        );
        continue;
      }
      resolved.set(result.sourceUrl, {
        sourceUrl: result.sourceUrl,
        affiliateUrl: result.affiliateUrl ?? '',
        affiliateLinkId: saved.get(result.sourceUrl)?.id ?? null,
        status: result.status,
        fromCache: false,
      });
    }
    return resolved;
  }
}

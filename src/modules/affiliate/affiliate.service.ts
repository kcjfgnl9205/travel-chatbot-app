import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AdpickService,
  LinkResult,
  STATUS_OK,
  adpickCarries,
  linkOk,
} from '../adpick/adpick.service';
import { AppConfig, CONFIG } from '../../config/app.config';
import { AffiliateLinksRepository } from '../database/repositories/affiliate-links.repository';

/**
 * 제휴 링크 해석: 캐시 조회 → 없으면 애드픽 변환 → 캐시 저장.
 *
 *   - 캐시 히트는 DB 조회 1번으로 끝내고
 *   - 미스만 동시에 변환한다.
 *
 * ⚠️ **이제 요청 경로가 아니라 클릭 경로에서 돈다** (0015). 카드를 만들 때 줄마다
 *    부르던 것을 `/r/{clickId}` 로 옮겼다 — 눌리는 줄은 많아야 하나인데 셋을 전부
 *    변환했고, 캐시가 빗나가면 카카오 5초 예산에서 2초를 먹었다.
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

  /**
   * [(sourceUrl, merchant), ...] → Map<sourceUrl, ResolvedLink>
   *
   * ⚠️ **애드픽이 취급하지 않는 제휴몰은 아예 빠진다** (스카이스캐너). 결과 Map 에
   *    없으면 호출부가 원본 주소로 보내는데, 그게 맞는 동작이다. 실패로 만들어
   *    넘기면 rate limit 과 경고만 축낸다 — 이유는 ADPICK_UNSUPPORTED_MERCHANTS 에.
   */
  async resolve(
    targets: { sourceUrl: string; merchant?: string | null }[],
  ): Promise<Map<string, ResolvedLink>> {
    const wanted = new Map<string, string | null>();
    for (const t of targets) {
      if (!t.sourceUrl || wanted.has(t.sourceUrl)) continue;
      if (!adpickCarries(t.merchant)) continue;
      wanted.set(t.sourceUrl, t.merchant ?? null);
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

  /**
   * **클릭 한 건을 위한 변환.** `/r/{clickId}` 가 쓴다 (0015).
   *
   * `resolve` 와 다른 점은 **기다리는 사람이 있다**는 것뿐이다. 사용자가 302 를
   * 기다리고 있으므로 `ADPICK_CLICK_TIMEOUT_SECONDS` 에서 끊고 null 을 준다 —
   * 호출부는 그때 원본 주소로 보낸다.
   *
   * ⚠️ **끊어도 변환을 취소하지 않는다.** 그대로 두면 몇백 ms 뒤에 끝나
   *    `affiliate_links` 에 남고, **같은 주소의 다음 클릭은 캐시 히트**가 된다.
   *    취소하면 느린 주소는 영원히 느리고 수수료도 영영 안 붙는다.
   *
   * @returns 커미션 링크, 또는 제때 못 받았거나 애드픽이 취급하지 않는 줄이면 null
   */
  async resolveForClick(
    sourceUrl: string,
    merchant: string | null,
  ): Promise<ResolvedLink | null> {
    if (!sourceUrl || !adpickCarries(merchant)) return null;

    // ⚠️ race 에 넘기기 전에 반드시 catch 를 달아둔다. 타임아웃이 이긴 뒤에 변환이
    //    터지면 핸들러 없는 rejection 이 되어 프로세스가 죽을 수 있다.
    const converting = this.resolve([{ sourceUrl, merchant }]).catch((err) => {
      this.logger.warn(`click-time convert failed url=${sourceUrl} err=${err}`);
      return null;
    });

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.config.adpickClickTimeoutMs);
      timer.unref?.();
    });

    try {
      const won = await Promise.race([converting, deadline]);
      return won?.get(sourceUrl) ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}

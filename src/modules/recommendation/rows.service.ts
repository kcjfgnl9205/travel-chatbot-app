import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { AppConfig, CONFIG, redirectUrl } from '../../config/app.config';
import { MemoryStoreService } from '../database/memory-store.service';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../database/repositories/recommendations.repository';
import * as t from '../kakao/templates';
import { RenderContext } from '../search/search.types';

/**
 * 한 페이지를 listCard 줄로 만들면서 **노출을 기록하고 클릭 링크를 발급한다.**
 *
 * 호텔·항공권이 거의 글자 그대로 같은 코드를 들고 있었다. 당연한데, 둘 다 같은 것을
 * 해야 하기 때문이다 —
 *
 *   recommendations 행 하나 → 항목마다 clickId 발급 → recommendation_items 행
 *     → 인메모리 폴백 → 줄 링크는 `/r/{clickId}`
 *
 * 사용자에게 노출되는 건 우리 리다이렉트뿐이고, 그 302 목적지가 최종 주소다.
 * 원본 주소는 DB 에만 남는다.
 *
 * ⚠️ **관광지는 `render` 가 아니라 `renderCounted` 를 쓴다.** 0012 에서 노출 스냅샷을
 *    그만두고 `attractions` 의 카운터로 옮겼다 — 그 목록은 우리 테이블에 있어서
 *    복원할 것이 없고, 링크에 노출별 값이 박히지도 않는다.
 *
 * ⚠️ **제휴 변환은 여기서 하지 않는다. 클릭 시점에 한다** (0015).
 *    `target_url` 에 원본 주소를 적어두면 `/r/{clickId}` 가 눌린 그 한 줄만 변환해
 *    302 한다. 예전에는 호출부가 줄마다 미리 변환해서 `links` 로 넘겼는데, 눌리는
 *    줄은 많아야 하나인데 셋을 전부 변환했고 캐시가 빗나가면 카카오 5초 예산에서
 *    2초를 먹었다 — 넘기면 말풍선이 통째로 안 나간다.
 *
 * ⚠️ **그래서 subid 도 여기서 안 붙인다.** 붙일 대상인 커미션 링크가 아직 없다.
 *    clickId 는 리다이렉트가 들고 있으므로 거기서 붙는다.
 */

/** 항목 하나를 "노출 기록 한 행 + 카드 한 줄" 로 만드는 데 필요한 것 전부. */
export interface ItemRow {
  /**
   * DB·로그에 남는 이름.
   *
   * 카드 제목과 다를 수 있다 — 항공권 카드는 시각과 경유를 찍지만, DB 에는
   * '대한항공 KE723 ICN→KIX' 로 남겨야 나중에 무엇이 노출됐는지 알아볼 수 있다.
   */
  label: string;
  /** 사용자가 최종 도착할 원본 주소. 제휴 변환의 입력이자 항목의 신원이다. */
  sourceUrl: string;
  title: string;
  description: string | null;
  /** 카드 썸네일이자 `image_url` 스냅샷. 항공권 카드에는 이미지가 없어 비어 온다. */
  imageUrl?: string | null;
  /**
   * 노출 시점 가격(원).
   *
   * ⚠️ **domain 으로 의미가 갈린다** — hotel: 1박 최저가, flight: 1인 총액.
   *    0013 이 두 칸을 하나로 합치면서 이름이 뜻을 안 들고 있게 됐으므로,
   *    집계할 때 domain 을 거는 건 읽는 쪽 책임이다.
   */
  price?: number | null;
  /**
   * 판매처 (agoda | booking | trip …).
   *
   * ⚠️ **이 값이 "제휴를 타는 줄인가" 도 정한다.** 항공권은 제휴를 타는 도메인인데
   *    스카이스캐너 줄만 못 탄다(애드픽에 광고주가 없다). 리다이렉트가 같은
   *    `adpickCarries` 로 다시 판정하므로, 예전의 `monetizable` 칸은 사라졌다 —
   *    두 곳이 각자 기억하면 언젠가 갈린다.
   */
  merchant?: string | null;
}

export interface RenderOptions {
  /** 실제로 검색을 돌린 provider. 통계에 남는다. */
  provider: string;
}

/** 노출마다 행을 쌓지 않는 도메인이 쓰는 한 줄. 링크가 이미 정해져 있다. */
export interface StaticRow {
  title: string;
  description: string | null;
  imageUrl?: string | null;
  /** 줄 전체가 가리킬 주소. 호출부가 만든다 (관광지는 `/a/{id}`). */
  linkUrl: string;
}

@Injectable()
export class RecommendationRowsService {
  private readonly logger = new Logger(RecommendationRowsService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly memory: MemoryStoreService,
  ) {}

  async render(items: ItemRow[], ctx: RenderContext, opts: RenderOptions): Promise<t.Json[]> {
    const recommendationId = await this.logRecommendation(ctx, opts.provider, items.length);

    const dbRows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];

    items.forEach((item, position) => {
      const clickId = newClickId();
      // ⚠️ **원본 주소를 그대로 적는다** (0015). 커미션 링크는 클릭 시점에 만들고,
      //    못 만들면 이 주소가 그대로 목적지가 된다 — 수익화는 못 해도 사용자는
      //    항목을 본다.
      const targetUrl = item.sourceUrl;
      if (!targetUrl) {
        this.logger.warn(`no destination for ${ctx.meta.kind}=${item.label}, skipping row`);
        return;
      }

      dbRows.push({
        recommendation_id: recommendationId,
        // 부모(recommendations)도 같은 값을 갖는다. 조인 없이 도메인별로 거른다.
        // ⚠️ **price 의 의미도 이 값이 정한다** — hotel 1박가 / flight 총액.
        domain: ctx.meta.kind,
        position,
        // ⚠️ 이 셋은 한 테이블에 같이 있어야 한다. /r/{clickId} 가 click_id 하나로
        //    목적지를 찾아 카운터를 올리는 걸 register_click() 이 왕복 한 번에 끝낸다.
        click_id: clickId,
        target_url: targetUrl,
        source_url: item.sourceUrl,
        item_name: item.label,
        price: item.price ?? null,
        merchant: item.merchant ?? null,
        image_url: item.imageUrl ?? null,
        // ⚠️ **노출 시점에는 비어 있다** (0015). 변환이 클릭 시점으로 갔으므로
        //    누르지 않은 줄은 영원히 null 이고, 그게 맞는 값이다. 리다이렉트가
        //    변환에 성공하면 그때 채운다.
        //
        //    집계에서 "변환 실패" 를 세려면 **`click_count > 0` 을 반드시 걸어라.**
        //    안 걸면 노출 전부가 실패로 세어진다.
        affiliate_link_id: null,
      });

      // DB 가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        itemName: item.label,
        sourceUrl: item.sourceUrl,
        targetUrl,
        // 리다이렉트가 이 값으로 "애드픽을 타는 줄인가" 를 가린다.
        merchant: item.merchant ?? null,
        userId: ctx.userId,
      });

      // 줄 전체가 링크가 된다. 링크는 최종 목적지가 아니라 우리 리다이렉트를 가리킨다.
      listItems.push(
        t.listItem({
          title: item.title,
          description: item.description,
          // 없으면 listItem 이 알아서 뺀다 — 그 줄만 사진 없이 나간다.
          imageUrl: item.imageUrl,
          linkUrl: redirectUrl(this.config, clickId),
        }),
      );
    });

    // ⚠️ **변환 실패 경고는 여기 없다.** 변환을 안 하기 때문이다 — 그 경고는
    //    실제로 변환하는 자리인 리다이렉트로 옮겨갔다 (0015).
    if (recommendationId && dbRows.length) await this.items.createMany(dbRows);
    return listItems;
  }

  /**
   * **노출 행을 만들지 않는 도메인의 렌더링** (관광지).
   *
   * 남기는 것은 `recommendations` 한 행 — "언제 누가 무엇을 물었나" 뿐이다. 항목별
   * 노출·클릭은 호출부가 자기 마스터 테이블의 카운터로 센다.
   *
   * 왜 관광지만 이 길인가 (0012 마이그레이션에 자세히) —
   *
   *   · 목록이 우리 `attractions` 테이블에 있어서 **덮어써지지 않는다.** 호텔·항공권은
   *     매번 새로 검색해 와서 스냅샷이 없으면 "그때 본 값" 이 영영 사라진다.
   *   · 링크에 노출별 값이 안 박힌다. 호텔·항공권의 clickId 는 애드픽 subid 로
   *     링크에 들어가서 노출마다 달라야 하는데, 관광지는 변환이 없다.
   *   · 줄 순서가 `attractions.rank` 로 고정이라 position 별 CTR 이 안 나온다.
   *
   * ⚠️ **clickId 를 발급하지 않는다.** 줄 링크가 `/r/{clickId}` 가 아니라 `/a/{id}` 라
   *    제휴 변환도 subid 도 걸릴 자리가 없다. 제휴를 타는 도메인이 이 길로 오면
   *    수수료가 통째로 새므로, 호텔·항공권은 반드시 `render` 를 쓴다.
   */
  async renderCounted(
    rows: StaticRow[],
    ctx: RenderContext,
    opts: { provider: string },
  ): Promise<t.Json[]> {
    await this.logRecommendation(ctx, opts.provider, rows.length);
    return rows.map((row) =>
      t.listItem({
        title: row.title,
        description: row.description,
        // 없으면 listItem 이 알아서 뺀다 — 그 줄만 사진 없이 나간다.
        imageUrl: row.imageUrl,
        linkUrl: row.linkUrl,
      }),
    );
  }

  /**
   * "이 요청에 이렇게 응답했다" 한 행. 도메인과 무관하게 남는다.
   *
   * persist:false 면 남기지 않는다 (진단 경로) — 섞이면 전환율 집계가 틀어진다.
   * 그때 null 이 돌아가고 호출부의 노출 기록도 자연히 건너뛰어진다.
   */
  private async logRecommendation(
    ctx: RenderContext,
    provider: string,
    itemCount: number,
  ): Promise<string | null> {
    if (ctx.persist === false) return null;
    const row = await this.recommendations.create({
      userId: ctx.userId,
      messageId: ctx.messageId,
      domain: ctx.meta.kind,
      // 항공권은 호텔의 city_slug 자리에 목적지를 넣는다. 도메인별 컬럼을 늘리지 않는다.
      citySlug: ctx.meta.placeSlug,
      provider,
      itemCount,
      guests: null,
      latencyMs: Date.now() - ctx.started,
      cacheHit: ctx.cacheHit,
    });
    return (row?.id as string) ?? null;
  }
}

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

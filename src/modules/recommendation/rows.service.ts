import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { AppConfig, CONFIG, redirectUrl } from '../../config/app.config';
import { applySubid } from '../adpick/adpick.service';
import { ResolvedLink } from '../affiliate/affiliate.service';
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
 * ⚠️ **제휴 변환은 여기서 하지 않는다.** 호출부가 이미 해석해서 `links` 로 넘긴다.
 *    그래야 관광지 모듈이 AffiliateModule 을 끌어오지 않는다 — 관광지는 예약할 게
 *    없어서 변환할 주소 자체가 없고, 그 사실이 모듈 그래프에 그대로 보이는 게 맞다.
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
  /** 판매처 (agoda | booking | trip …). */
  merchant?: string | null;
}

export interface RenderOptions {
  /** 실제로 검색을 돌린 provider. 통계에 남는다. */
  provider: string;
  /**
   * 미리 해석해둔 제휴 링크. **빠지면 "변환을 다루지 않는 도메인" 이라는 뜻이다**(관광지).
   *
   * 빈 Map 은 의미가 다르다 — "변환을 시도했는데 하나도 못 건졌다" 이고, 그건 수익이
   * 새는 상황이라 경고를 남겨야 한다. undefined 와 빈 Map 을 같이 취급하면 그 경고가
   * 관광지에서도 뜨고, 그러면 아무도 경고를 안 읽게 된다.
   */
  links?: Map<string, ResolvedLink>;
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
    // 제휴 링크를 아예 안 다루는 도메인인가. 빈 Map 과 구별해야 한다 (RenderOptions 참고).
    const monetized = opts.links !== undefined;

    const recommendationId = await this.logRecommendation(ctx, opts.provider, items.length);

    const dbRows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];
    /** 제휴 변환이 안 돼 원본 주소로 나가는 줄. 수익화가 안 되는 노출이다. */
    const unconverted: string[] = [];

    items.forEach((item, position) => {
      const clickId = newClickId();
      const link = opts.links?.get(item.sourceUrl);
      // 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 항목을 본다.
      const destination = link?.affiliateUrl ?? item.sourceUrl;
      if (!destination) {
        this.logger.warn(`no destination for ${ctx.meta.kind}=${item.label}, skipping row`);
        return;
      }
      // 목적지가 원본과 같다 = 커미션 링크가 아니다. 여기서 세지 않으면
      // "링크는 잘 열리는데 수수료가 안 들어온다" 를 영영 못 찾는다.
      if (monetized && destination === item.sourceUrl) unconverted.push(item.label);
      // ⚠️ 변환하지 않는 도메인에는 subid 도 붙이지 않는다. 지도 주소에 추적 파라미터를
      //    달아봐야 아무도 읽지 않고 링크만 지저분해진다.
      const targetUrl = monetized ? applySubid(destination, clickId, this.config) : destination;

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
        // ⚠️ **변환에 실패해도 null 을 적는다.** 제휴를 안 타는 도메인(undefined)과
        //    "타는데 실패했다"(null)를 가르는 값이라, 실패를 안 적으면 수수료가 새는
        //    노출이 집계에서 통째로 빠진다 — 찾으려던 것만 안 보이게 된다.
        affiliate_link_id: monetized ? (link?.affiliateLinkId ?? null) : null,
      });

      // DB 가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        itemName: item.label,
        sourceUrl: item.sourceUrl,
        targetUrl,
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

    if (unconverted.length) {
      // 경고로 남긴다. 배포를 막을 일은 아니지만 방치하면 그대로 매출이 샌다.
      this.logger.warn(
        `애드픽 변환 실패 ${unconverted.length}/${listItems.length}건 — 원본 주소로 나간다: ` +
          unconverted.join(', '),
      );
    }

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
   * ⚠️ **`links` 를 받지 않는다.** 제휴를 타는 도메인이 이 길로 오면 subid 가 안 붙어
   *    수수료가 통째로 새므로, 애초에 넘길 수 없게 해둔다.
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

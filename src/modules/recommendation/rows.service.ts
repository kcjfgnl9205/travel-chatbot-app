import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';

import { AppConfig, CONFIG, redirectUrl } from '../../config/app.config';
import { applySubid } from '../adpick/adpick.service';
import { ResolvedLink } from '../affiliate/affiliate.service';
import { MemoryStoreService } from '../database/memory-store.service';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../database/repositories/recommendations.repository';
import * as t from '../kakao/templates';
import { RenderContext, SearchKind } from '../search/search.types';

/**
 * 한 페이지를 listCard 줄로 만들면서 **노출을 기록하고 클릭 링크를 발급한다.**
 *
 * 세 도메인(호텔·항공권·관광지)이 거의 글자 그대로 같은 코드를 들고 있었다. 당연한데,
 * 셋 다 같은 것을 해야 하기 때문이다 —
 *
 *   recommendations 행 하나 → 항목마다 clickId 발급 → recommendation_items 행
 *     → 인메모리 폴백 → 줄 링크는 `/r/{clickId}`
 *
 * 사용자에게 노출되는 건 우리 리다이렉트뿐이고, 그 302 목적지가 최종 주소다.
 * 원본 주소는 DB 에만 남는다.
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
  /**
   * 카드 썸네일. **DB 에는 여기서 안 넣는다** — 썸네일이 있는 도메인(호텔·관광지)이
   * 자기 `detail.image_url` 로 따로 넣는다. 항공권 카드에는 이미지가 없다.
   */
  imageUrl?: string | null;
  /**
   * 도메인별 위성 테이블에 남길 한 행 (recommendation_item_attractions 등).
   *
   * **공통 테이블에는 세 도메인이 전부 쓰는 것만 남아 있다.** 가격·판매처·제휴링크·
   * 썸네일처럼 한두 도메인만 쓰던 값은 전부 여기로 내려왔다. 특히 가격은 호텔(1박
   * 최저가)과 항공권(1인 총액)이 의미가 달라 컬럼 이름부터 갈라져 있다.
   *
   * ⚠️ **제휴 링크(affiliate_link_id)는 여기 넣지 않는다.** 그건 도메인이 아니라
   *    이 서비스가 해석해서 채운다 (아래 render 참고).
   *
   * ⚠️ **키는 DB 컬럼명(snake_case)이다.** 여기서 이름을 바꾸지 않고 그대로 넣는다 —
   *    중간에 매핑을 두면 컬럼을 추가할 때마다 고칠 자리가 하나 더 생긴다.
   * ⚠️ **읽을 계획이 있는 값만 넣는다.** 채우기만 하고 아무도 안 보는 칸은 나중에
   *    값이 틀어져도 알 수가 없다.
   */
  detail?: Record<string, unknown>;
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

/**
 * 도메인별 상세가 들어가는 테이블.
 *
 * 공통 테이블은 하나이고 여기만 갈린다 — click_id·position·클릭 카운터는 세 도메인이
 * 똑같이 하는 일이라 쪼갤 이유가 없다 (0007 마이그레이션 주석 참고).
 */
const DETAIL_TABLES: Record<SearchKind, string> = {
  hotel: 'recommendation_item_hotels',
  flight: 'recommendation_item_flights',
  attraction: 'recommendation_item_attractions',
};

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

    // persist:false 면 통계를 안 남긴다 (진단 경로). recommendationId 가 null 이 되고
    // 아래 items.createMany 도 자연히 건너뛴다.
    const recommendation =
      ctx.persist === false
        ? null
        : await this.recommendations.create({
            userId: ctx.userId,
            messageId: ctx.messageId,
            domain: ctx.meta.kind,
            // 항공권은 호텔의 city_slug 자리에 목적지를 넣는다. 도메인별 컬럼을 늘리지 않는다.
            citySlug: ctx.meta.placeSlug,
            provider: opts.provider,
            itemCount: items.length,
            guests: null,
            latencyMs: Date.now() - ctx.started,
            cacheHit: ctx.cacheHit,
          });
    const recommendationId = (recommendation?.id as string) ?? null;

    const dbRows: Record<string, unknown>[] = [];
    /** 위성 테이블에 들어갈 행. 상세가 하나도 없는 항목은 아예 안 만든다. */
    const detailRows: Record<string, unknown>[] = [];
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

      // id 를 DB 기본값에 맡기지 않고 여기서 만든다. 위성 행이 이 값을 가리켜야 하는데,
      // insert 응답의 순서를 믿고 되짚는 것보다 미리 정해두는 쪽이 확실하다.
      const itemId = randomUUID();
      // 제휴 링크는 도메인이 아니라 여기서 해석한 값이라 이 자리에서 합친다.
      // 변환을 다루지 않는 도메인(관광지)의 테이블에는 그 컬럼이 아예 없다.
      const detail = compact(item.detail);
      // ⚠️ **변환에 실패해도 null 을 적어 행을 남긴다.** 빈 값이라고 지우면 그 노출은
      //    위성 행조차 없어서 "변환 실패한 노출" 집계에서 통째로 빠진다 — 수수료가
      //    새는 지점을 찾으려고 세는 값인데 정작 샌 것만 안 보이게 된다.
      if (monetized) detail.affiliate_link_id = link?.affiliateLinkId ?? null;
      if (Object.keys(detail).length) detailRows.push({ item_id: itemId, ...detail });

      dbRows.push({
        id: itemId,
        recommendation_id: recommendationId,
        // 부모(recommendations)도 같은 값을 갖는다. 조인 없이 도메인별로 보고,
        // 어느 위성 테이블에 상세가 있는지도 이 값이 가리킨다.
        domain: ctx.meta.kind,
        position,
        // ⚠️ 이 셋은 한 테이블에 같이 있어야 한다. /r/{clickId} 가 click_id 하나로
        //    목적지를 찾아 카운터를 올리는 걸 register_click() 이 왕복 한 번에 끝낸다.
        click_id: clickId,
        target_url: targetUrl,
        source_url: item.sourceUrl,
        item_name: item.label,
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

    if (recommendationId && dbRows.length) {
      const saved = await this.items.createMany(dbRows);
      // 공통 행이 안 들어갔으면 위성도 넣지 않는다 — item_id 가 가리킬 행이 없어서
      // 외래키 위반만 한 번 더 나고, 로그에 원인이 둘로 늘어난다.
      if (saved && detailRows.length) {
        await this.items.createDetails(DETAIL_TABLES[ctx.meta.kind], detailRows);
      }
    }
    return listItems;
  }
}

/**
 * 값이 있는 칼럼만 남긴다.
 *
 * AI 결과는 필드가 비어 오는 게 흔하다. 전부 null 인 행까지 위성 테이블에 넣으면
 * "이 노출은 상세가 없다" 와 "상세가 전부 비었다" 가 같은 뜻인데 행 수만 달라진다.
 *
 * ⚠️ **0 과 false 는 남긴다.** 항공권의 `stops: 0` 이 직항이라 비었다고 지우면
 *    "직항" 이라는 정보가 통째로 사라진다.
 */
function compact(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  return Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== null && value !== undefined),
  );
}

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

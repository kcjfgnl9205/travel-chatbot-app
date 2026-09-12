import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { applySubid } from '../adpick/adpick.service';
import { AffiliateService, ResolvedLink } from '../affiliate/affiliate.service';
import { AppConfig, CONFIG, redirectUrl } from '../../config/app.config';
import { MemoryStoreService } from '../database/memory-store.service';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../database/repositories/recommendations.repository';
import * as cards from '../kakao/cards';
import * as t from '../kakao/templates';
import { searchName } from '../search/search-name';
import {
  RenderContext,
  SearchContext,
  SearchDomain,
  SearchMeta,
} from '../search/search.types';
import {
  HOTEL_PROVIDER,
  Hotel,
  HotelProvider,
  HotelQuery,
  isHotel,
  listDescription,
} from './hotel.types';

/**
 * 호텔 도메인.
 *
 * 라우터에게 **두 가지만** 제공한다 — 어떻게 찾는가(`search`)와 어떻게 한 줄로
 * 그리는가(`rows`). 캐시·페이지·콜백·고지는 [SearchService](../search/search.service.ts)
 * 가 도메인과 무관하게 처리한다.
 *
 *   provider 검색(gpt-5-mini + 웹 검색) → 중복 제거
 *     → (그릴 때) 원본 주소 → 애드픽 커미션 링크 변환 → clickId 발급 → 노출 기록
 *
 * 사용자에게 노출되는 건 우리 리다이렉트(`/r/{clickId}`)뿐이고, 그 302 목적지가
 * 애드픽 커미션 링크다. 원본 주소는 DB 에만 남는다.
 *
 * ⚠️ **search() 를 요청 경로에서 부르면 안 된다.** 카카오는 5초 안에 응답을 받아야
 *    하는데 AI 검색은 7~30초다. 라우터는 이걸 백그라운드에서만 부른다.
 */
const DOMAIN = 'hotel';

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

/**
 * 같은 호텔이 리스트에 두 번 나가지 않게 한다.
 *
 * AI provider 는 같은 호텔을 이름만 다르게 여러 번 주기도 한다
 * ('호텔 그란비아 오사카' / 'Hotel Granvia Osaka').
 * 이름은 못 믿으므로 sourceUrl(호텔 신원)로 판정한다.
 */
export function dedupe(hotels: Hotel[], logger?: Logger): Hotel[] {
  const seen = new Set<string>();
  const unique: Hotel[] = [];
  for (const hotel of hotels) {
    const key = hotel.sourceUrl || hotel.name;
    if (seen.has(key)) {
      logger?.log(`duplicate hotel dropped: ${hotel.name} (${key})`);
      continue;
    }
    seen.add(key);
    unique.push(hotel);
  }
  return unique;
}

@Injectable()
export class HotelService implements SearchDomain<Hotel> {
  readonly kind = 'hotel' as const;
  private readonly logger = new Logger(HotelService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(HOTEL_PROVIDER) private readonly provider: HotelProvider,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly affiliate: AffiliateService,
    private readonly memory: MemoryStoreService,
  ) {}

  /** 실제로 붙어 있는 데이터 소스. 설정값이 아니라 주입된 구현이 답이다 (/health). */
  get providerName(): string {
    return this.provider.name;
  }

  /** 지금 검색할 수 있는가. 키가 없으면 false — 라우터가 헛된 대기를 안 만든다. */
  get ready(): boolean {
    return this.provider.enabled !== false;
  }

  /** ⚠️ 느리다(7~30초). 백그라운드에서만 부른다. */
  async search(ctx: SearchContext): Promise<Hotel[]> {
    const hotels = await this.provider.search(queryOf(ctx));
    // 중복 제거를 저장 **전에** 한다. 저장 후에 지우면 20건이 페이지마다 줄고,
    // 2페이지에 1페이지에서 이미 본 호텔이 다시 나온다.
    return dedupe(hotels, this.logger).slice(0, ctx.limit);
  }

  isItem(item: unknown): item is Hotel {
    return isHotel(item);
  }

  headerTitle(meta: SearchMeta, count: number, start: number): string {
    // 2페이지부터는 몇 번째인지 알려준다. 안 그러면 같은 카드가 또 온 것처럼 보인다.
    return start
      ? `${meta.placeName} 호텔 ${start + 1}~${start + count}번째`
      : `${meta.placeName} 호텔 ${count}곳`;
  }

  moreText(meta: SearchMeta): string {
    return `${meta.placeName} 호텔 더 보기`;
  }

  quickReplies(meta: SearchMeta): t.Json[] {
    return cards.placeQuickReplies('hotel', meta.placeName);
  }

  /**
   * 한 페이지를 listCard 줄로 만든다. **노출 기록과 클릭 링크 발급이 여기서 일어난다.**
   *
   * 페이지를 자른 **뒤에** 애드픽을 부르는 게 중요하다 — 이번 카드에 안 나갈 호텔까지
   * 변환하면 분당 60회 rate limit 을 헛되이 쓴다.
   */
  async rows(hotels: Hotel[], ctx: RenderContext): Promise<t.Json[]> {
    // 원본 주소 → 애드픽 커미션 링크. 캐시에 있으면 API 를 안 탄다.
    // affiliate_links 행이 곧 호텔의 신원이기도 하다 — 별도 호텔 마스터를 두지 않는다.
    const links =
      ctx.links ??
      (await this.affiliate.resolve(
        hotels
          .filter((h) => h.sourceUrl)
          .map((h) => ({ sourceUrl: h.sourceUrl, merchant: h.merchant })),
      ));

    // persist:false 면 통계를 안 남긴다 (진단 경로). recommendationId 가 null 이 되고
    // 아래 items.createMany 도 자연히 건너뛴다.
    const recommendation =
      ctx.persist === false
        ? null
        : await this.recommendations.create({
            userId: ctx.userId,
            messageId: ctx.messageId,
            domain: DOMAIN,
            citySlug: ctx.meta.placeSlug,
            provider: this.provider.name,
            itemCount: hotels.length,
            guests: null,
            latencyMs: Date.now() - ctx.started,
            cacheHit: ctx.cacheHit,
          });
    const recommendationId = (recommendation?.id as string) ?? null;

    const rows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];
    /** 애드픽 변환이 안 돼 원본 주소로 나가는 줄. 수익화가 안 되는 노출이다. */
    const unconverted: string[] = [];

    hotels.forEach((hotel, position) => {
      const clickId = newClickId();
      const link = links.get(hotel.sourceUrl);
      // 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 호텔을 본다.
      const destination = link?.affiliateUrl ?? hotel.sourceUrl;
      if (!destination) {
        this.logger.warn(`no destination for hotel=${hotel.name}, skipping row`);
        return;
      }
      // 목적지가 원본과 같다 = 커미션 링크가 아니다. 여기서 세지 않으면
      // "링크는 잘 열리는데 수수료가 안 들어온다"를 영영 못 찾는다.
      if (destination === hotel.sourceUrl) unconverted.push(hotel.name);
      const targetUrl = applySubid(destination, clickId, this.config);

      rows.push({
        recommendation_id: recommendationId,
        affiliate_link_id: link?.affiliateLinkId ?? null,
        position,
        click_id: clickId,
        hotel_name: hotel.name,
        price_from: hotel.priceFrom ?? null,
        merchant: hotel.merchant ?? null,
        thumbnail_url: hotel.thumbnailUrl ?? null,
        source_url: hotel.sourceUrl,
        target_url: targetUrl,
      });

      // DB 가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        itemName: hotel.name,
        sourceUrl: hotel.sourceUrl,
        targetUrl,
        userId: ctx.userId,
      });

      // 줄 전체가 링크가 된다. 링크는 애드픽이 아니라 우리 리다이렉트를 가리킨다.
      listItems.push(
        t.listItem({
          title: hotel.name,
          description: listDescription(hotel),
          imageUrl: hotel.thumbnailUrl,
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

    if (recommendationId && rows.length) await this.items.createMany(rows);
    return listItems;
  }
}

/**
 * 검색 질의.
 *
 * ⚠️ **날짜·인원이 없다.** 캐시를 지역으로만 가르기로 했기 때문이다(고지는 카드
 *    아래에 붙는다). provider 는 원래 둘 다 optional 이라 프롬프트가 알아서 빠진다.
 */
export function queryOf(ctx: SearchContext): HotelQuery {
  return {
    citySlug: ctx.place.slug,
    cityName: searchName(ctx),
    guests: null,
    limit: ctx.limit,
  };
}

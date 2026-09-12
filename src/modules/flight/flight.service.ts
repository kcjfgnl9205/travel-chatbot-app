import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { applySubid } from '../adpick/adpick.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { AppConfig, CONFIG, redirectUrl } from '../../config/app.config';
import { MemoryStoreService } from '../database/memory-store.service';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../database/repositories/recommendations.repository';
import * as cards from '../kakao/cards';
import * as t from '../kakao/templates';
import {
  RenderContext,
  SearchContext,
  SearchDomain,
  SearchMeta,
} from '../search/search.types';
import {
  FLIGHT_PROVIDER,
  Flight,
  FlightProvider,
  FlightQuery,
  flightKey,
  isFlight,
  listRowDescription,
  listRowTitle,
} from './flight.types';

/**
 * 항공권 도메인.
 *
 * 호텔과 모양이 같다 — 같은 제약(5초 예산 · 느린 AI 검색 · 애드픽 rate limit)을 받으므로
 * 같은 모양이 되는 게 맞다. 다른 점만 적어둔다.
 *
 *   · **카드가 listCard 다.** 예전에는 itemCard 캐러셀이었는데 **그룹챗봇이 itemCard 를
 *     못 그린다** — 팀톡방에서 항공권만 말풍선이 통째로 사라졌다. 정보 밀도를 잃더라도
 *     보이는 카드가 낫다. 상세는 줄 링크로 넘긴다.
 *   · **같은 sourceUrl 이 여러 편에 걸린다** (노선 검색 결과 페이지). 그래서 중복 제거는
 *     주소가 아니라 편명+시각으로 한다.
 *   · **날짜를 검색에 넘기지 않는다.** 캐시를 노선·왕복여부로만 가르기 때문이다.
 *     대신 카드 아래 안내에 반영하지 않은 조건을 적는다.
 */
const DOMAIN = 'flight';

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

/**
 * 같은 항공편이 리스트에 두 번 나가지 않게 한다.
 *
 * 호텔처럼 sourceUrl 로 판정하면 안 된다 — 항공권은 여러 편이 같은 노선 검색
 * 페이지를 가리키므로 줄이 한 줄만 남는다. 편명+출발시각이 항공편의 신원이다.
 */
export function dedupe(flights: Flight[], logger?: Logger): Flight[] {
  const seen = new Set<string>();
  const unique: Flight[] = [];
  for (const flight of flights) {
    const key = flightKey(flight);
    if (seen.has(key)) {
      logger?.log(`duplicate flight dropped: ${flight.airline} (${key})`);
      continue;
    }
    seen.add(key);
    unique.push(flight);
  }
  return unique;
}

@Injectable()
export class FlightService implements SearchDomain<Flight> {
  readonly kind = 'flight' as const;
  private readonly logger = new Logger(FlightService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FLIGHT_PROVIDER) private readonly provider: FlightProvider,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly affiliate: AffiliateService,
    private readonly memory: MemoryStoreService,
  ) {}

  /** 실제로 붙어 있는 데이터 소스. 설정값이 아니라 주입된 구현이 답이다 (/health). */
  get providerName(): string {
    return this.provider.name;
  }

  /** ⚠️ 느리다(7~30초). 백그라운드에서만 부른다. */
  async search(ctx: SearchContext): Promise<Flight[]> {
    const flights = await this.provider.search(this.queryOf(ctx));
    return dedupe(flights, this.logger).slice(0, ctx.limit);
  }

  isItem(item: unknown): item is Flight {
    return isFlight(item);
  }

  headerTitle(meta: SearchMeta, count: number, start: number): string {
    const route = `${meta.fromName ?? this.config.flightDefaultOriginName}→${meta.placeName}`;
    return start
      ? `${route} 항공권 ${start + 1}~${start + count}번째`
      : `${route} 항공권 ${count}편`;
  }

  moreText(meta: SearchMeta): string {
    return `${meta.placeName} 항공권 더 보기`;
  }

  quickReplies(meta: SearchMeta): t.Json[] {
    return cards.placeQuickReplies('flight', meta.placeName);
  }

  async rows(flights: Flight[], ctx: RenderContext): Promise<t.Json[]> {
    // 원본 주소 → 애드픽 커미션 링크. 캐시에 있으면 API 를 안 탄다.
    // 항공권은 여러 편이 같은 주소를 공유하므로 변환 호출 수가 줄 수보다 적다.
    const links =
      ctx.links ??
      (await this.affiliate.resolve(
        flights
          .filter((f) => f.sourceUrl)
          .map((f) => ({ sourceUrl: f.sourceUrl, merchant: f.merchant })),
      ));

    const recommendation =
      ctx.persist === false
        ? null
        : await this.recommendations.create({
            userId: ctx.userId,
            messageId: ctx.messageId,
            domain: DOMAIN,
            // 호텔의 city_slug 자리에 목적지를 넣는다. 도메인별 컬럼을 늘리지 않는다.
            citySlug: ctx.meta.placeSlug,
            provider: this.provider.name,
            itemCount: flights.length,
            guests: null,
            latencyMs: Date.now() - ctx.started,
            cacheHit: ctx.cacheHit,
          });
    const recommendationId = (recommendation?.id as string) ?? null;

    const rows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];
    /** 애드픽 변환이 안 돼 원본 주소로 나가는 줄. 수익화가 안 되는 노출이다. */
    const unconverted: string[] = [];

    flights.forEach((flight, position) => {
      const clickId = newClickId();
      const link = links.get(flight.sourceUrl);
      // 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 항공권을 본다.
      const destination = link?.affiliateUrl ?? flight.sourceUrl;
      if (!destination) {
        this.logger.warn(`no destination for flight=${flight.airline}, skipping row`);
        return;
      }
      if (destination === flight.sourceUrl) unconverted.push(flight.airline);
      const targetUrl = applySubid(destination, clickId, this.config);
      const label = itemLabel(flight);

      rows.push({
        recommendation_id: recommendationId,
        affiliate_link_id: link?.affiliateLinkId ?? null,
        position,
        click_id: clickId,
        // hotel_name 컬럼이지만 담기는 건 "노출된 항목의 이름" 이다
        // (0002 마이그레이션 주석 참고).
        hotel_name: label,
        price_from: flight.priceFrom ?? null,
        merchant: flight.merchant ?? null,
        thumbnail_url: null,
        source_url: flight.sourceUrl,
        target_url: targetUrl,
      });

      this.memory.put(clickId, {
        recommendationId,
        itemName: label,
        sourceUrl: flight.sourceUrl,
        targetUrl,
        userId: ctx.userId,
      });

      listItems.push(
        t.listItem({
          title: listRowTitle(flight),
          description: listRowDescription(flight),
          linkUrl: redirectUrl(this.config, clickId),
        }),
      );
    });

    if (unconverted.length) {
      this.logger.warn(
        `애드픽 변환 실패 ${unconverted.length}/${listItems.length}건 — 원본 주소로 나간다: ` +
          unconverted.join(', '),
      );
    }

    if (recommendationId && rows.length) await this.items.createMany(rows);
    return listItems;
  }

  /**
   * 검색 질의.
   *
   * 출발지는 라우터가 채워준다 — 사용자가 말하지 않았으면 서울(ICN)이고, 그 사실은
   * 카드 아래 안내에 적힌다(cards.noticeText). 되묻지 않는 대신 고쳐 말할 단서를 준다.
   */
  queryOf(ctx: SearchContext): FlightQuery {
    const from = ctx.from;
    return {
      originSlug: from?.slug ?? 'seoul',
      originName: from?.canonicalName ?? this.config.flightDefaultOriginName,
      originCode: from?.iata ?? this.config.flightDefaultOriginCode,
      destSlug: ctx.place.slug,
      destName: ctx.place.canonicalName,
      destCode: ctx.place.iata,
      tripType: ctx.tripType === 'ow' ? 'oneway' : 'round',
      limit: ctx.limit,
      originAssumed: !from,
    };
  }
}

/** DB·로그에 남기는 항목 이름. '대한항공 KE723 ICN→KIX' */
export function itemLabel(flight: Flight): string {
  return [flight.airline, flight.flightNo, `${flight.originCode}→${flight.destCode}`]
    .filter(Boolean)
    .join(' ');
}

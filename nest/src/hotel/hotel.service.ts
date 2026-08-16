import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { applySubid } from '../adpick/adpick.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { AppConfig, CONFIG, redirectUrl } from '../config/configuration';
import { MemoryStoreService } from '../db/memory-store.service';
import { MessagesRepository } from '../db/repositories/messages.repository';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../db/repositories/recommendations.repository';
import { UsersRepository } from '../db/repositories/users.repository';
import * as t from '../kakao/templates';
import {
  KakaoSkillPayload,
  actionParamsOf,
  blockNameOf,
  paramOf,
  userKeyOf,
  utteranceOf,
} from '../kakao/skill-payload';
import { CITIES, hasCity, parse } from '../nlu/nlu';
import { SearchCacheService } from '../search-cache/search-cache.service';
import { Hotel, HotelQuery, listDescription } from './hotel.types';
import { StaticHotelProvider } from './providers/static.provider';

/**
 * 호텔 추천 유스케이스.
 *
 * 컨트롤러는 얇게 두고 흐름은 전부 여기 모은다.
 *
 *   발화 파싱 → 사용자/메시지 로깅
 *     → 캐시 또는 provider 검색 (AI/크롤링/고정) : 호텔 + 원본 주소
 *     → 원본 주소 → 애드픽 커미션 링크 변환 (캐시 우선)
 *     → 추천 저장 (+clickId 발급)
 *     → 카카오 listCard 조립
 *
 * 사용자에게 노출되는 건 우리 리다이렉트(`/r/{clickId}`)뿐이고,
 * 그 302 목적지가 애드픽 커미션 링크다. 원본 주소는 DB에만 남는다.
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
export class HotelService {
  private readonly logger = new Logger(HotelService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly provider: StaticHotelProvider,
    private readonly users: UsersRepository,
    private readonly messages: MessagesRepository,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly affiliate: AffiliateService,
    private readonly searchCache: SearchCacheService,
    private readonly memory: MemoryStoreService,
  ) {}

  // ------------------------------------------------------------ 진입점
  async handle(payload: KakaoSkillPayload): Promise<t.Json> {
    const started = Date.now();
    const utterance = utteranceOf(payload);
    const parsed = parse(utterance, paramOf(payload, 'city', 'location', 'sys_location'));

    const user = await this.users.getOrCreate(userKeyOf(payload));
    const userId = (user?.id as string) ?? null;

    const message = await this.messages.log({
      userId,
      domain: DOMAIN,
      utterance,
      blockName: blockNameOf(payload),
      parsedCity: parsed.citySlug,
      params: actionParamsOf(payload),
      rawPayload: payload,
    });
    const messageId = (message?.id as string) ?? null;

    if (!hasCity(parsed)) return this.askCity();

    const query: HotelQuery = {
      citySlug: parsed.citySlug ?? '',
      cityName: parsed.cityName ?? '',
      guests: parsed.guests,
      limit: this.config.hotelResultLimit,
    };

    // 캐시에 있으면 provider 를 안 부른다.
    // AI/크롤링이 붙으면 이 한 줄이 5초 예산과 호출 비용을 좌우한다.
    const { hotels, cacheHit } = await this.searchCache.getOrCall(
      DOMAIN,
      this.provider.name,
      query,
      () => this.provider.search(query),
    );
    if (!hotels.length) return this.noResult(query.cityName);

    return this.respondWithHotels(hotels, query, {
      userId,
      messageId,
      guests: parsed.guests,
      started,
      cacheHit,
    });
  }

  // ------------------------------------------------------- 응답 조립
  private async respondWithHotels(
    input: Hotel[],
    query: HotelQuery,
    ctx: {
      userId: string | null;
      messageId: string | null;
      guests: number | null;
      started: number;
      cacheHit: boolean;
    },
  ): Promise<t.Json> {
    // 중복 제거 → 자르기 순서가 중요하다. 반대로 하면 중복이 5줄 자리를 먹는다.
    // listCard 는 최대 5줄이고, 자르기 전에 애드픽 변환을 돌리면
    // 보여주지도 못할 호텔 때문에 rate limit 을 헛되이 쓴다.
    const hotels = dedupe(input, this.logger).slice(0, t.MAX_LIST_ITEMS);

    // 원본 주소 → 애드픽 커미션 링크. 캐시에 있으면 API 를 안 탄다.
    // affiliate_links 행이 곧 호텔의 신원이기도 하다 — 별도 호텔 마스터를 두지 않는다.
    const links = await this.affiliate.resolve(
      hotels
        .filter((h) => h.sourceUrl)
        .map((h) => ({ sourceUrl: h.sourceUrl, merchant: h.merchant })),
    );

    const recommendation = await this.recommendations.create({
      userId: ctx.userId,
      messageId: ctx.messageId,
      domain: DOMAIN,
      citySlug: query.citySlug,
      provider: this.provider.name,
      itemCount: hotels.length,
      guests: ctx.guests,
      latencyMs: Date.now() - ctx.started,
      cacheHit: ctx.cacheHit,
    });
    const recommendationId = (recommendation?.id as string) ?? null;

    const rows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];

    hotels.forEach((hotel, position) => {
      const clickId = newClickId();
      const link = links.get(hotel.sourceUrl);
      // 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 호텔을 본다.
      const destination = link?.affiliateUrl ?? hotel.sourceUrl;
      if (!destination) {
        this.logger.warn(`no destination for hotel=${hotel.name}, skipping row`);
        return;
      }
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

      // DB가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        hotelName: hotel.name,
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

    if (!listItems.length) return this.noResult(query.cityName);
    if (recommendationId) await this.items.createMany(rows);

    return t.listCard({
      headerTitle: `${query.cityName} 호텔 추천 ${listItems.length}곳`,
      items: listItems,
      buttons: [t.messageButton('다른 도시 보기', '호텔 추천해줘')],
      quickReplies: this.cityQuickReplies(query.citySlug),
    });
  }

  // ------------------------------------------------------- 예외 응답
  askCity(): t.Json {
    return t.simpleText(
      '어느 도시 호텔을 찾으세요?\n예) 오사카 호텔 추천해줘',
      this.cityQuickReplies(),
    );
  }

  private noResult(cityName: string): t.Json {
    return t.simpleText(
      `${cityName} 호텔은 아직 준비 중이에요. 다른 도시를 골라주세요!`,
      this.cityQuickReplies(),
    );
  }

  cityQuickReplies(exclude?: string | null): t.Json[] {
    return CITIES.filter((c) => c.slug !== exclude).map((c) =>
      t.quickReply(`${c.nameKo} 호텔`, `${c.nameKo} 호텔 추천해줘`),
    );
  }
}

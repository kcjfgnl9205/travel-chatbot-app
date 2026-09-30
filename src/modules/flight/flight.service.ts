import { Inject, Injectable, Logger } from '@nestjs/common';

import { dedupeBy } from '../../common/dedupe';
import { AffiliateService } from '../affiliate/affiliate.service';
import { AppConfig, CONFIG } from '../../config/app.config';
import * as cards from '../kakao/cards';
import * as t from '../kakao/templates';
import { RecommendationRowsService } from '../recommendation/rows.service';
import {
  RenderContext,
  SearchContext,
  SearchDomain,
  SearchMeta,
} from '../search/search.types';
import {
  FLIGHT_PROVIDER,
  Flight,
  FlightOffer,
  FlightProvider,
  FlightQuery,
  flightKey,
  isFlightOffer,
  offerDescription,
  offerLabel,
  offerTitle,
  toOffers,
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

/**
 * 같은 항공편이 리스트에 두 번 나가지 않게 한다.
 *
 * 호텔처럼 sourceUrl 로 판정하면 안 된다 — 항공권은 여러 편이 같은 노선 검색
 * 페이지를 가리키므로 줄이 한 줄만 남는다. 편명+출발시각이 항공편의 신원이다.
 */
export function dedupe(flights: Flight[], logger?: Logger): Flight[] {
  return dedupeBy(flights, {
    label: 'flight',
    keyOf: flightKey,
    nameOf: (flight) => flight.airline,
    logger,
  });
}

@Injectable()
export class FlightService implements SearchDomain<FlightOffer> {
  readonly kind = 'flight' as const;
  private readonly logger = new Logger(FlightService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FLIGHT_PROVIDER) private readonly provider: FlightProvider,
    private readonly affiliate: AffiliateService,
    private readonly renderer: RecommendationRowsService,
  ) {}

  /** 실제로 붙어 있는 데이터 소스. 설정값이 아니라 주입된 구현이 답이다 (/health). */
  get providerName(): string {
    return this.provider.name;
  }

  /** 지금 검색할 수 있는가. 키가 없으면 false — 라우터가 헛된 대기를 안 만든다. */
  get ready(): boolean {
    return this.provider.enabled !== false;
  }

  /**
   * ⚠️ 느리다(7~30초). 백그라운드에서만 부른다.
   *
   * **저장되는 건 편이 아니라 플랫폼 줄이다.** 모델이 준 편들에서 시세·소요시간·
   * 항공사를 뽑아 플랫폼별 한 줄로 접는다 — 편별로 한 줄씩 내면 줄마다 다른
   * 편명·가격을 찍으면서 **링크는 전부 같은 검색 페이지로 갔다.**
   */
  async search(ctx: SearchContext): Promise<FlightOffer[]> {
    const flights = await this.provider.search(this.queryOf(ctx));
    // 편 단위 중복은 여기서 접는다 — 같은 편이 두 번 들어오면 시세 폭이 왜곡된다.
    const unique = dedupe(flights, this.logger);
    const offers = toOffers(unique, this.queryOf(ctx).tripType);

    this.logger.log(
      `flight result ${ctx.place.canonicalName} flights=${flights.length} ` +
        `unique=${unique.length} offers=${offers.length}`,
    );
    return offers.slice(0, ctx.limit);
  }

  isItem(item: unknown): item is FlightOffer {
    return isFlightOffer(item);
  }

  /**
   * 카드 머리글. **시세를 여기 적는다** — 줄마다 반복하면 40자를 다 먹는다.
   *
   * 줄이 플랫폼 두세 개뿐이라 "몇 번째" 를 셀 일이 없다.
   */
  headerTitle(meta: SearchMeta, _count: number, _start: number): string {
    const route = `${meta.fromName ?? this.config.flightDefaultOriginName}→${meta.placeName}`;
    return `${route} 항공권`;
  }

  moreText(meta: SearchMeta): string {
    return `${meta.placeName} 항공권 더 보기`;
  }

  quickReplies(meta: SearchMeta): t.Json[] {
    return cards.placeQuickReplies('flight', meta.placeName);
  }

  /**
   * 줄 하나가 **플랫폼 하나**다.
   *
   * ⚠️ 편별로 줄을 내던 때는 줄마다 다른 편명·시각·가격을 찍으면서 링크는 전부
   *    같은 검색 페이지로 갔다. 이제 보내는 곳이 곧 줄의 제목이라 어긋날 자리가 없다.
   */
  async rows(offers: FlightOffer[], ctx: RenderContext): Promise<t.Json[]> {
    // 원본 주소 → 애드픽 커미션 링크. 캐시에 있으면 API 를 안 탄다.
    const links =
      ctx.links ??
      (await this.affiliate.resolve(
        offers
          .filter((o) => o.sourceUrl)
          .map((o) => ({ sourceUrl: o.sourceUrl, merchant: o.merchant })),
      ));

    return this.renderer.render(
      offers.map((offer) => ({
        label: offerLabel(offer),
        sourceUrl: offer.sourceUrl,
        title: offerTitle(offer),
        description: offerDescription(offer),
        // ⚠️ **1인 총액의 하한**이다. 범위의 아래쪽을 남긴다 — 확정 운임이 아니라
        //    모델이 웹에서 본 값이므로 집계할 때 그 사실을 잊으면 안 된다.
        price: offer.priceLow,
        merchant: offer.merchant,
        // 항공권 카드에는 이미지가 없다 — imageUrl 을 안 넘기면 image_url 은 null 이다.
      })),
      ctx,
      { provider: this.provider.name, links },
    );
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

import { Inject, Injectable, Logger } from '@nestjs/common';

import { dedupeBy } from '../../common/dedupe';
import { AffiliateService } from '../affiliate/affiliate.service';
import * as cards from '../kakao/cards';
import * as t from '../kakao/templates';
import { RecommendationRowsService } from '../recommendation/rows.service';
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

/**
 * 같은 호텔이 리스트에 두 번 나가지 않게 한다.
 *
 * AI provider 는 같은 호텔을 이름만 다르게 여러 번 주기도 한다
 * ('호텔 그란비아 오사카' / 'Hotel Granvia Osaka').
 * 이름은 못 믿으므로 sourceUrl(호텔 신원)로 판정한다.
 */
export function dedupe(hotels: Hotel[], logger?: Logger): Hotel[] {
  const identity = identityOf(hotels);
  return dedupeBy(hotels, {
    label: 'hotel',
    keyOf: identity,
    nameOf: (hotel) => hotel.name,
    logger,
  });
}

/**
 * 무엇을 "같은 호텔" 로 볼지 정한다. **주소 하나로는 안 된다.**
 *
 * 두 가지 실패가 서로 반대다.
 *
 *   주소로만 판정  모델이 호텔마다 다른 예약 페이지를 줘야 하는데, **검색 결과
 *                  페이지 하나를 여러 곳에 붙이면 전부 같은 키가 되어 한 줄만 남는다.**
 *                  항공권에서 이미 겪은 실패다(dedupe.ts 주석) — 호텔에서도 났다.
 *   이름으로만 판정 '호텔 그란비아 오사카' / 'Hotel Granvia Osaka' 가 다른 값이 된다.
 *                  모델은 같은 호텔을 표기만 바꿔 여러 번 준다.
 *
 * 그래서 **주소가 신원 노릇을 하는지 먼저 본다.** 한 주소에 서로 다른 이름이 셋 이상
 * 달려 있으면 그건 호텔 페이지가 아니라 목록 페이지다 — 그 주소를 쓰는 항목들은
 * 이름으로 판정한다. 나머지는 지금까지처럼 주소로 판정한다.
 *
 * ⚠️ **왜 둘이 아니라 셋인가.** 한 주소에 이름이 둘이면 대개 같은 호텔의 표기 차이다
 *    ('호텔 그란비아 오사카' / 'Hotel Granvia Osaka'). 한글과 영문은 문자열로 견줄
 *    수가 없어서 **주소가 그 둘을 잇는 유일한 다리**다. 둘에서 갈라버리면 중복이
 *    그대로 카드에 나간다. 반면 목록 페이지는 모델이 여러 곳에 같이 붙이므로 셋을
 *    넘는다 — 실제로 스무 곳 전부에 같은 주소가 붙어 한 줄만 남았다.
 *
 * ⚠️ 둘인 경우는 여전히 애매하고, 그때는 **합치는 쪽으로 기운다.** 줄이 하나만 남는
 *    것보다 같은 호텔이 두 줄 나오는 게 낫지만, 둘 중 하나를 골라야 한다면 더 흔한
 *    쪽(표기 차이)을 잡는다.
 */
const LISTING_PAGE_NAMES = 3;
export function identityOf(hotels: Hotel[]): (hotel: Hotel) => string {
  const namesByUrl = new Map<string, Set<string>>();
  for (const hotel of hotels) {
    if (!hotel.sourceUrl) continue;
    const names = namesByUrl.get(hotel.sourceUrl) ?? new Set<string>();
    names.add(normalizeName(hotel.name));
    namesByUrl.set(hotel.sourceUrl, names);
  }

  return (hotel) => {
    const listing =
      hotel.sourceUrl && (namesByUrl.get(hotel.sourceUrl)?.size ?? 0) >= LISTING_PAGE_NAMES;
    if (!hotel.sourceUrl || listing) return `name:${normalizeName(hotel.name)}`;
    return `url:${hotel.sourceUrl}`;
  };
}

/** 표기 흔들림을 지운다. 공백·문장부호 차이로 같은 호텔이 갈리지 않게. */
function normalizeName(name: string): string {
  return name.replace(/[\s·・\-–—()[\],.'"`’]/g, '').toLowerCase();
}

@Injectable()
export class HotelService implements SearchDomain<Hotel> {
  readonly kind = 'hotel' as const;
  private readonly logger = new Logger(HotelService.name);

  constructor(
    @Inject(HOTEL_PROVIDER) private readonly provider: HotelProvider,
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

  /** ⚠️ 느리다(7~30초). 백그라운드에서만 부른다. */
  async search(ctx: SearchContext): Promise<Hotel[]> {
    const hotels = await this.provider.search(queryOf(ctx));
    // 중복 제거를 저장 **전에** 한다. 저장 후에 지우면 20건이 페이지마다 줄고,
    // 2페이지에 1페이지에서 이미 본 호텔이 다시 나온다.
    const unique = dedupe(hotels, this.logger);

    // ⚠️ **줄이 몇 개나 남았는지 한 줄로 남긴다.** "호텔이 하나만 나온다" 를 만났을 때
    //    모델이 적게 준 건지 중복으로 접힌 건지 갈라야 하는데, 그 전에는 로그를
    //    여러 줄 맞춰봐야 알 수 있었다.
    this.logger.log(
      `hotel result city=${ctx.place.canonicalName} found=${hotels.length} unique=${unique.length}`,
    );
    return unique.slice(0, ctx.limit);
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

    return this.renderer.render(
      hotels.map((hotel) => ({
        label: hotel.name,
        sourceUrl: hotel.sourceUrl,
        title: hotel.name,
        description: listDescription(hotel),
        imageUrl: hotel.thumbnailUrl,
        // 가격은 **1박 최저가**라 항공권의 총액과 같은 칸에 둘 수 없다 — 그래서
        // 컬럼 이름부터 다르다. 평점은 "높은 줄이 더 눌리나" 를 보려면 노출 시점
        // 값이 있어야 한다 (캐시는 갱신되면 덮어써진다).
        detail: {
          star_rating: hotel.starRating,
          review_score: hotel.reviewScore,
          price_per_night: hotel.priceFrom,
          merchant: hotel.merchant,
          image_url: hotel.thumbnailUrl,
        },
      })),
      ctx,
      { provider: this.provider.name, links },
    );
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

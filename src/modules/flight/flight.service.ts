import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import * as t from '../kakao/templates';
import { routeAirports } from './airports';
import { linkOffers } from './link-offers';
import { datedSearchUrl } from './search-url';
import { RecommendationRowsService } from '../recommendation/rows.service';
import {
  RenderContext,
  SearchContext,
  SearchDomain,
  SearchMeta,
} from '../search/search.types';
import {
  FlightOffer,
  FlightQuery,
  isFlightOffer,
  offerDescription,
  offerLabel,
  offerTitle,
} from './flight.types';

/**
 * 항공권 도메인. **호텔·관광지와 달리 검색을 하지 않는다.**
 *
 * 줄 링크는 어차피 우리가 IATA 코드로 조립하므로, 시세 한 줄을 포기하면 모델을
 * 부를 이유가 없다 — 그 판단과 대가는 [link-offers.ts](./link-offers.ts) 에 적혀 있다.
 * 그래서 이 도메인에는 **느린 경로가 없다.** 항상 5초 예산 안에서 끝난다.
 *
 *   · **카드가 listCard 다.** 예전에는 itemCard 캐러셀이었는데 **그룹챗봇이 itemCard 를
 *     못 그린다** — 팀톡방에서 항공권만 말풍선이 통째로 사라졌다. 정보 밀도를 잃더라도
 *     보이는 카드가 낫다. 상세는 줄 링크로 넘긴다.
 *   · **줄 하나가 플랫폼 하나다.** 보내는 곳이 곧 줄의 신원이라 중복이 생길 자리가 없다.
 *   · **날짜·인원은 링크에만 들어간다.** 카드에 적는 시세가 없으므로 어긋날 것도 없다.
 */

@Injectable()
export class FlightService implements SearchDomain<FlightOffer> {
  readonly kind = 'flight' as const;
  private readonly logger = new Logger(FlightService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly renderer: RecommendationRowsService,
  ) {}

  /**
   * /health 에 찍는 데이터 소스 이름.
   *
   * ⚠️ 설정값이 아니라 **실제 동작**을 적는다. 예전에 HOTEL_PROVIDER 를 그대로
   *    보여주다가, 아무도 안 읽는 값이 'static' 이라 AI 를 껐다고 믿게 만든 적이 있다.
   */
  get providerName(): string {
    return 'link';
  }

  /** 모델을 안 부르므로 **키와 무관하게 항상 검색할 수 있다.** */
  get ready(): boolean {
    return true;
  }

  /**
   * 즉답. **AI 를 부르지 않고 카드를 만든다.**
   *
   * 라우터는 `peek` 이 값을 주면 캐시도 선점도 건너뛴다. 항공권은 늘 여기서 끝난다.
   */
  async peek(ctx: SearchContext): Promise<FlightOffer[]> {
    return linkOffers(this.queryOf(ctx));
  }

  /**
   * 느린 경로. **실제로는 안 탄다** — `peek` 이 항상 값을 주기 때문이다.
   *
   * 그래도 비워두지 않는 이유는, 라우터가 어떤 사정으로 여기까지 내려와도
   * **같은 카드가 나와야** 하기 때문이다. 둘이 갈리면 "미리 본 것과 나중에 온 것이
   * 다른" 버그가 된다.
   */
  async search(ctx: SearchContext): Promise<FlightOffer[]> {
    return linkOffers(this.queryOf(ctx));
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


  /**
   * 줄 하나가 **플랫폼 하나**다.
   *
   * ⚠️ 편별로 줄을 내던 때는 줄마다 다른 편명·시각·가격을 찍으면서 링크는 전부
   *    같은 검색 페이지로 갔다. 이제 보내는 곳이 곧 줄의 제목이라 어긋날 자리가 없다.
   *
   * ⚠️ **줄마다 제휴 여부가 다르다.** 트립닷컴·마이리얼트립은 애드픽을 타고
   *    스카이스캐너는 안 탄다(광고주가 없다) — 그 줄은 원본 주소로 그대로 보낸다.
   *    `adpickCarries` 가 양쪽에서 같은 판단을 하므로 변환 호출과 경고 집계가
   *    어긋나지 않는다.
   */
  async rows(offers: FlightOffer[], ctx: RenderContext): Promise<t.Json[]> {
    // ⚠️ **여기서 주소를 다시 만든다. 저장된 값을 그대로 쓰지 않는다.**
    //    모델이 주는 건 빈 검색 폼(노선 페이지)이라, 카드에서 가격을 보고 누른
    //    사람이 날짜를 다시 입력해야 한다. **사용자가 말한 날짜·인원으로** 검색된
    //    상태를 연다 — 말하지 않았으면 내일 출발·7일 뒤 귀국·1인이다.
    //
    //    렌더 시점인 것이 핵심이다 — 캐시는 날짜를 키에 넣지 않고 24시간 살기 때문에
    //    (0004), 저장해 두면 내일 캐시를 맞은 사람이 어제 날짜를 받는다.
    const dated = offers.map((offer) => ({
      offer,
      sourceUrl: datedSearchUrl(offer, new Date(ctx.started), ctx.trip) ?? offer.sourceUrl,
    }));

    // ⚠️ **애드픽을 여기서 부르지 않는다** (0015). 날짜가 박힌 주소라 캐시가 거의
    //    빗나갔고, 미스면 요청 경로에서 2초를 기다렸다 — 그게 5초 예산을 넘기면
    //    말풍선이 통째로 안 나간다. 변환은 눌린 줄 하나만 `/r/{clickId}` 가 한다.
    return this.renderer.render(
      dated.map(({ offer, sourceUrl }) => ({
        label: offerLabel(offer),
        sourceUrl,
        title: offerTitle(offer),
        description: offerDescription(offer),
        // ⚠️ **가격을 안 남긴다.** 조사하지 않으므로 넣을 값이 없다. 집계에서
        //    항공권 행의 price 는 null 이고, 그게 사실이다.
        // ⚠️ 애드픽에 없는 플랫폼(스카이스캐너)은 "변환 실패" 가 아니라 "처음부터
        //    안 타는 줄" 이다. 그 판정은 리다이렉트가 이 merchant 로 다시 한다 —
        //    `adpickCarries` 가 양쪽에서 같은 답을 내므로 갈릴 자리가 없다.
        merchant: offer.merchant,
        // 항공권 카드에는 이미지가 없다 — imageUrl 을 안 넘기면 image_url 은 null 이다.
      })),
      ctx,
      { provider: this.providerName },
    );
  }

  /**
   * 검색 질의.
   *
   * 출발지는 라우터가 채워준다 — 사용자가 말하지 않았으면 서울이고, 그 사실은
   * 카드 아래 안내에 적힌다(cards.noticeText). 되묻지 않는 대신 고쳐 말할 단서를 준다.
   *
   * ⚠️ **공항 코드는 `from.iata` 가 아니라 노선을 보고 정한다** — 서울은 공항이
   *    둘이라 국내선이면 김포다 ([airports.ts](./airports.ts)).
   */
  queryOf(ctx: SearchContext): FlightQuery {
    const from = ctx.from;
    const { originCode, destCode } = routeAirports(from, ctx.place, {
      name: this.config.flightDefaultOriginName,
      code: this.config.flightDefaultOriginCode,
    });
    return {
      originSlug: from?.slug ?? 'seoul',
      originName: from?.canonicalName ?? this.config.flightDefaultOriginName,
      originCode,
      destSlug: ctx.place.slug,
      destName: ctx.place.canonicalName,
      destCode,
      tripType: ctx.tripType === 'ow' ? 'oneway' : 'round',
      limit: ctx.limit,
      originAssumed: !from,
    };
  }
}

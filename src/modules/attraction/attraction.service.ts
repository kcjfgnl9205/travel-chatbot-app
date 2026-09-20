import { Inject, Injectable, Logger } from '@nestjs/common';

import { dedupeBy } from '../../common/dedupe';
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
import { listDescription } from './attraction-card';
import {
  ATTRACTION_PROVIDER,
  Attraction,
  AttractionProvider,
  AttractionQuery,
  attractionKey,
  isAttraction,
} from './attraction.types';

/**
 * 관광지 도메인.
 *
 * **호텔·항공권과 결정적으로 다른 점 하나: 제휴 링크 단계가 통째로 없다.**
 * 관광지는 우리가 파는 게 아니라 장소라서 애드픽에 변환할 주소가 없다. 링크는
 * 이름+도시로 만든 구글맵 주소이고, 그래서 rate limit 도 변환 실패 폴백도 없다.
 *
 * 그럼에도 `/r/{clickId}` 는 그대로 거친다. 수수료는 없어도 **어떤 관광지를 눌렀는지**는
 * 알아야 다음 추천이 나아진다 — 카카오 링크는 브라우저를 바로 열어서 한 홉을 끼우지
 * 않으면 아무 신호도 오지 않는다.
 */

/**
 * 같은 관광지가 리스트에 두 번 나가지 않게 한다.
 *
 * 이름으로 판정하면 '오사카성' / '오사카 성' / 'Osaka Castle' 이 전부 다른 값이 된다.
 * 지도 링크는 이름을 정규화해 만든 값이라 표기 흔들림을 어느 정도 흡수하고,
 * 무엇보다 **사용자가 도착하는 곳**이 같으면 같은 관광지다.
 */
export function dedupe(attractions: Attraction[], logger?: Logger): Attraction[] {
  return dedupeBy(attractions, {
    label: 'attraction',
    keyOf: attractionKey,
    nameOf: (attraction) => attraction.name,
    logger,
  });
}

@Injectable()
export class AttractionService implements SearchDomain<Attraction> {
  readonly kind = 'attraction' as const;
  private readonly logger = new Logger(AttractionService.name);

  constructor(
    @Inject(ATTRACTION_PROVIDER) private readonly provider: AttractionProvider,
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

  /** ⚠️ 느리다(7~30초, 사진까지 찾으면 더). 백그라운드에서만 부른다. */
  async search(ctx: SearchContext): Promise<Attraction[]> {
    const attractions = await this.provider.search(queryOf(ctx));
    return dedupe(attractions, this.logger).slice(0, ctx.limit);
  }

  isItem(item: unknown): item is Attraction {
    return isAttraction(item);
  }

  headerTitle(meta: SearchMeta, count: number, start: number): string {
    return start
      ? `${meta.placeName} 관광지 ${start + 1}~${start + count}번째`
      : `${meta.placeName} 관광지 ${count}곳`;
  }

  moreText(meta: SearchMeta): string {
    return `${meta.placeName} 관광지 더 보기`;
  }

  quickReplies(meta: SearchMeta): t.Json[] {
    return cards.placeQuickReplies('attraction', meta.placeName);
  }

  /**
   * ⚠️ **`links` 를 넘기지 않는다** — 그게 이 도메인이 다른 점이다.
   *
   * 관광지는 우리가 파는 게 아니라 장소라서 애드픽에 변환할 주소가 없다. 렌더러는
   * links 가 없으면 원본(지도 링크)을 그대로 목적지로 쓰고, 변환 실패 경고도
   * affiliate_link_id 도 subid 도 만들지 않는다.
   *
   * 그럼에도 `/r/{clickId}` 는 그대로 거친다. 수수료는 없어도 **어떤 관광지를 눌렀는지**
   * 는 알아야 다음 추천이 나아진다.
   */
  async rows(attractions: Attraction[], ctx: RenderContext): Promise<t.Json[]> {
    return this.renderer.render(
      attractions.map((attraction) => ({
        label: attraction.name,
        // 목적지가 곧 지도 링크다. 이름+도시로 우리가 만든 주소라 죽을 일이 없다.
        sourceUrl: attraction.mapUrl,
        title: attraction.name,
        description: listDescription(attraction),
        imageUrl: attraction.imageUrl,
        // ⚠️ **입장료를 price_from 에 넣지 않는다.** 그 칸은 단위가 원인데 관광지
        //    입장료는 현지 통화(엔·바트·동)라 비교 불가능한 숫자가 섞인다.
        //    (0003 마이그레이션 주석 참고)
        priceFrom: null,
      })),
      ctx,
      { provider: this.provider.name },
    );
  }
}

export function queryOf(ctx: SearchContext): AttractionQuery {
  return {
    citySlug: ctx.place.slug,
    cityName: searchName(ctx),
    limit: ctx.limit,
  };
}

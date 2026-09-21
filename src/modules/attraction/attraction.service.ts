import { Inject, Injectable, Logger } from '@nestjs/common';

import { dedupeBy } from '../../common/dedupe';
import { AttractionPlacesRepository } from '../database/repositories/attraction-places.repository';
import { PlacesRepository } from '../database/repositories/places.repository';
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
    private readonly catalog: AttractionPlacesRepository,
    private readonly places: PlacesRepository,
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
    const picked = dedupe(attractions, this.logger).slice(0, ctx.limit);

    // **목록의 영구 신원과 갱신 시각을 여기서 남긴다.** 배치 경로에만 두면 두 경로가
    // 달라진다 —
    //
    //   · place_id 를 안 남기면: 사용자가 물어서 찾은 도시는 30일 캐시에만 있고,
    //     캐시가 비면 목록을 처음부터 다시 만들어야 한다(모델 재호출).
    //   · 도장을 안 찍으면: 방금 채운 도시를 **배치가 한 시간 뒤에 또 채운다.**
    //     "아직 채운 적 없는 도시" 로 보이기 때문이다. 같은 데이터를 구글 6회 +
    //     모델 2회로 다시 사는 셈이다.
    //
    // ⚠️ 요청 경로가 아니라 백그라운드에서만 도는 코드다(카카오 5초 예산 밖).
    if (picked.length) {
      await this.catalog.replaceCity(
        ctx.place.id,
        picked.map((attraction) => attraction.placeId),
      );
      await this.places.markAttractionsRefreshed(ctx.place.id);
    }
    return picked;
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
        // ⚠️ **평점·리뷰수는 여기 없다.** 구글 콘텐츠라 영구 보관하지 않는다 —
        //    30일 캐시(search_results)에만 살고, 노출 스냅샷에는 구글이 영구 저장을
        //    허용하는 place_id 와 우리가 만든 값만 남긴다.
        detail: {
          place_id: attraction.placeId,
          category: attraction.category,
          area: attraction.area,
          image_url: attraction.imageUrl,
        },
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

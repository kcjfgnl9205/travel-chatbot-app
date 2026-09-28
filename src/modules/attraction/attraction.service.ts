import { Inject, Injectable, Logger } from '@nestjs/common';

import { dedupeBy } from '../../common/dedupe';
import { AttractionBackfillService } from './attraction-backfill';
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
 * **호텔·항공권과 다른 점 둘.**
 *
 *   1. 제휴 링크 단계가 통째로 없다. 관광지는 우리가 파는 게 아니라 장소라서
 *      애드픽에 변환할 주소가 없다. 링크는 이름+도시로 만든 구글맵 주소다.
 *   2. **평소에는 AI 를 부르지 않는다.** 목록은 DB 에서 읽는다. 모델이 나서는 건
 *      **아무도 안 넣은 도시**뿐이고, 그때도 사용자에게 바로 가는 게 아니라
 *      DB 에 먼저 들어간다 ([attraction-backfill.ts](./attraction-backfill.ts)).
 *
 * 그럼에도 `/r/{clickId}` 는 그대로 거친다. 수수료는 없어도 **어떤 관광지를 눌렀는지**는
 * 알아야 다음 추천이 나아진다 — 카카오 링크는 브라우저를 바로 열어서 한 홉을 끼우지
 * 않으면 아무 신호도 오지 않는다.
 */

/**
 * 같은 관광지가 리스트에 두 번 나가지 않게 한다.
 *
 * DB 에 유니크 인덱스(city_id, name)가 걸려 있어 사실상 겹칠 일이 없지만, 이 함수는
 * 캐시에서 되살린 목록에도 걸린다 — 인덱스를 걸기 전에 들어간 행이 캐시에 남아 있을
 * 수 있으므로 한 겹 더 둔다.
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
    private readonly backfill: AttractionBackfillService,
  ) {}

  /** 실제로 붙어 있는 데이터 소스. 설정값이 아니라 주입된 구현이 답이다 (/health). */
  get providerName(): string {
    return this.provider.name;
  }

  /** 지금 조회할 수 있는가. DB 가 없으면 false — 라우터가 헛된 대기를 안 만든다. */
  get ready(): boolean {
    return this.provider.enabled !== false;
  }

  /**
   * **요청 경로에서 즉시 답한다 — 목록이 이미 있을 때만.**
   *
   * DB 쿼리 하나라 카카오 5초 예산 안에서 끝난다. 0008 까지는 구글 6회 + 모델 2회 +
   * 사진 N회로 7~30초가 걸려서 첫 질문부터 콜백을 기다려야 했는데, 그 콜백이
   * **단톡방에서 실제로 오는지 검증되지 않은** 경로라 그 자체가 위험이었다.
   *
   * 빈 도시일 때만 `null` 을 돌려 느린 경로로 넘긴다. 거기서 모델이 채운다 —
   * 그건 몇 초짜리라 여기서 할 수 없다.
   *
   * ⚠️ **백필이 꺼져 있으면 `[]` 다.** null 을 주면 느린 경로가 모델을 부르는데,
   *    부를 수 없는 상태에서 "찾고 있어요" 를 보내면 영원히 안 오는 약속이 된다.
   */
  async peek(ctx: SearchContext): Promise<Attraction[] | null> {
    const items = await this.read(ctx);
    if (items.length) return items;
    return this.backfill.enabled ? null : [];
  }

  /**
   * 느린 경로. **모델이 채우고 다시 읽는다.**
   *
   * 다시 읽는 이유 — 모델이 준 것을 그대로 카드로 만들면 DB 에 들어간 것과 화면이
   * 어긋날 수 있다(유니크 충돌로 빠진 행, 이름 정규화). **DB 가 정본이다.**
   */
  async search(ctx: SearchContext): Promise<Attraction[]> {
    const query = queryOf(ctx);
    await this.backfill.fill(query.cityId, query.cityName);
    return this.read(ctx);
  }

  /** DB 조회 한 번. peek 과 search 가 같은 경로를 타야 결과가 안 갈린다. */
  private async read(ctx: SearchContext): Promise<Attraction[]> {
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
        // ⚠️ **관광지 단위 집계는 attraction_id 로 한다.** 이름은 관리 화면에서
        //    바뀔 수 있지만 이 값은 그대로다.
        detail: {
          attraction_id: attraction.id,
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
    cityId: ctx.place.id,
    citySlug: ctx.place.slug,
    cityName: searchName(ctx),
    limit: ctx.limit,
  };
}

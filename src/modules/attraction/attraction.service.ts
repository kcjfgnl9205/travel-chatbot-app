import { Inject, Injectable, Logger } from '@nestjs/common';

import { dedupeBy } from '../../common/dedupe';
import { AppConfig, CONFIG, attractionRedirectUrl } from '../../config/app.config';
import { AttractionBackfillService } from './attraction-backfill';
import { AttractionsRepository } from '../database/repositories/attractions.repository';
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
 * 그럼에도 리다이렉트 한 홉은 그대로 거친다. 수수료는 없어도 **어떤 관광지를 눌렀는지**는
 * 알아야 다음 추천이 나아진다 — 카카오 링크는 브라우저를 바로 열어서 한 홉을 끼우지
 * 않으면 아무 신호도 오지 않는다.
 *
 *   3. **그 한 홉이 `/r/{clickId}` 가 아니라 `/a/{id}` 다.** 노출마다 키를 발급하고
 *      행을 쌓는 대신 `attractions` 의 카운터를 올린다 — 목록이 우리 테이블에 있어서
 *      노출 시점 값을 복사해둘 이유가 없다 (0012 마이그레이션).
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
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ATTRACTION_PROVIDER) private readonly provider: AttractionProvider,
    private readonly renderer: RecommendationRowsService,
    private readonly backfill: AttractionBackfillService,
    /** 조회는 provider 가 하고, 이쪽은 **노출 카운터**만 올린다 (0012). */
    private readonly attractions: AttractionsRepository,
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
   * ⚠️ **노출마다 행을 쌓지 않는다** — 그게 호텔·항공권과 가장 다른 점이다.
   *
   * 저 둘은 매 검색마다 목록을 새로 받아오고 캐시는 갱신되면 덮어써지므로, "그때
   * 사용자가 본 값" 을 `recommendation_items` 에 복사해두지 않으면 영영 복원이 안 된다.
   * 관광지 목록은 **우리 `attractions` 테이블에 영구히 있다.** 복사해둘 것이 없다.
   *
   * 그래서 남기는 것은 `recommendations` 한 행과 **카운터 +1** 이다. 여러 사람이 같은
   * 도시를 물어도 행이 안 자란다 (0012 마이그레이션).
   *
   * 링크도 노출별이 아니라 **관광지별로 고정**이다(`/a/{id}`). 호텔·항공권의 clickId 는
   * 애드픽 subid 로 링크에 박혀서 노출마다 달라야 하는데, 관광지는 변환 자체가 없다.
   */
  async rows(attractions: Attraction[], ctx: RenderContext): Promise<t.Json[]> {
    const items = await this.renderer.renderCounted(
      attractions.map((attraction) => ({
        title: attraction.name,
        description: listDescription(attraction),
        imageUrl: attraction.imageUrl,
        // 목적지는 리다이렉트가 이름+도시로 다시 만든다. 여기서 mapUrl 을 넘기지
        // 않는 이유 — 관리 화면에서 이름을 고치면 **새 이름이 맞는 주소**다.
        linkUrl: attractionRedirectUrl(this.config, attraction.id),
      })),
      ctx,
      { provider: this.provider.name },
    );

    // 진단 경로(persist:false)는 통계를 안 남긴다. 카운터도 마찬가지다 —
    // 여기서 올리면 아무도 안 본 노출이 분모에 섞여 클릭률이 낮게 보인다.
    if (ctx.persist !== false) {
      await this.attractions.registerImpressions(attractions.map((a) => a.id));
    }
    return items;
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

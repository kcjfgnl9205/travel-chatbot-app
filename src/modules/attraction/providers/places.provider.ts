import { Inject, Injectable, Logger } from '@nestjs/common';

import { mapsUrl } from '../../../common/maps-url';
import { clip, text } from '../../../common/parse';
import { AppConfig, CONFIG } from '../../../config/app.config';
import { OpenAiService, parseJsonLoose } from '../../openai/openai.service';
import { FoundImage, findAttractionImage } from '../attraction-image';
import { PlaceCandidate, searchCityAttractions } from '../attraction-place';
import { Attraction, AttractionProvider, AttractionQuery } from '../attraction.types';

/**
 * 관광지 provider. **구글이 후보를 주고, 모델이 순서를 정하고, 위키미디어가 사진을 붙인다.**
 *
 *   1. 구글 Places  도시의 관광지 후보 (타입별 6회)   → 존재가 보장된다
 *   2. 모델         그중 N곳을 순서대로 고른다 (1회)  → 한국인 여행자 관점
 *   3. 위키미디어   사진 (ko → en → commons)          → 주소가 죽지 않는다
 *
 * **호텔·항공권의 2단 웹 검색 구조를 쓰지 않는다.** 그쪽은 "웹에 뭐가 있나" 부터
 * 모델이 찾아야 하지만, 관광지는 **구글이 정답 목록을 갖고 있다.** 모델에게
 * 검색까지 시키면 없는 곳을 섞고 가격·주소를 지어낸다 — 그게 이 도메인에서
 * 실제로 문제였다.
 *
 * ⚠️ **모델에게 사실을 묻지 않는다.** 이름·평점·주소·위치는 구글 값 그대로 쓰고,
 *    모델은 **place_id 목록의 순서만** 돌려준다. 새 항목을 만들 자리도, 값을 고칠
 *    자리도 스키마에 없다.
 *
 * ⚠️ 느리다(구글 6회 + 모델 1회 + 사진 N회). 카카오 5초 예산 안에서 부르면 안 된다.
 *    AttractionService 가 콜백/백그라운드에서만 호출한다.
 */

const RANK_INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 관광지 추천 순서를 정하는 어시스턴트다.',
  '주어진 후보 목록에서 고를 뿐, 새로운 장소를 만들지 않는다.',
  '각 후보의 place_id 를 추천 순서대로 나열해 JSON 으로만 답한다.',
  '처음 그 도시에 가는 한국인 여행자 기준으로, 갔으면 봐야 할 곳을 앞에 둔다.',
  // 구글 순서는 인기·거리 기준이라 이걸 안 시키면 비슷한 성격이 앞에 몰린다.
  '**카테고리를 섞어라.** 같은 성격의 장소를 연달아 놓지 않는다.',
  // 평점만 보고 줄 세우면 리뷰 3개짜리 카페가 1등이 된다.
  '평점이 높아도 리뷰 수가 적으면 뒤로 둔다. 관광지로서의 유명세를 우선한다.',
  '한국인에게 익숙하지 않은 현지 편의시설(쇼핑몰 푸드코트 등)은 뒤로 둔다.',
  '**요청한 개수를 반드시 채워라.** 후보가 그만큼 없으면 있는 것을 전부 낸다.',
  '인사말·서론·설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

export const RANK_SCHEMA = {
  type: 'json_schema' as const,
  name: 'attraction_ranking',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['place_ids'],
    properties: {
      place_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '추천 순서대로 나열한 place_id. 후보 목록에 있는 값만 쓴다',
      },
    },
  },
};

/**
 * 영문명을 따로 받는 스키마. **사진을 찾으려고만 쓴다.**
 *
 * 구글은 `languageCode: ko` 로 물어서 한국어 이름을 주는데, 위키미디어 영어판과
 * 커먼즈는 영문명이라야 걸린다. 이건 사실 조회가 아니라 **표기 변환**이라
 * 모델이 잘하는 일이다 (지어낼 자리가 없다 — 모르면 null 로 두라고 시킨다).
 */
export const NAMES_SCHEMA = {
  type: 'json_schema' as const,
  name: 'attraction_names_en',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['names'],
    properties: {
      names: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['place_id', 'name_en'],
          properties: {
            place_id: { type: 'string' },
            name_en: {
              type: ['string', 'null'],
              description: '영어 위키백과·커먼즈에 실릴 만한 공식 영문명. 모르면 null',
            },
          },
        },
      },
    },
  },
};

const NAMES_INSTRUCTIONS = [
  '너는 지명 표기 변환기다.',
  '주어진 관광지의 공식 영문명을 JSON 으로만 답한다 (오사카성 → Osaka Castle).',
  '영어 위키백과나 위키미디어 커먼즈에 실릴 만한 표기를 쓴다.',
  '**모르면 지어내지 말고 null 로 둔다.** 틀린 영문명은 엉뚱한 사진을 물고 온다.',
].join(' ');

/** 로그에 남길 모델 원문 길이. */
const LOG_TEXT = 200;

@Injectable()
export class GooglePlacesAttractionProvider implements AttractionProvider {
  readonly name = 'google+openai';
  private readonly logger = new Logger(GooglePlacesAttractionProvider.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
  ) {}

  /**
   * 구글 키가 없으면 후보를 못 모은다. 모델만으로는 이 도메인이 돌지 않는다 —
   * 그게 이 설계의 전제다.
   */
  get enabled(): boolean {
    return Boolean(this.config.googlePlacesApiKey) && this.openai.enabled;
  }

  async search(query: AttractionQuery): Promise<Attraction[]> {
    if (!this.config.googlePlacesApiKey) {
      this.logger.warn('GOOGLE_PLACES_API_KEY 가 없어 관광지 검색을 건너뛴다');
      return [];
    }

    const started = Date.now();
    const candidates = await searchCityAttractions(query.cityName, {
      apiKey: this.config.googlePlacesApiKey,
      timeoutMs: this.config.googlePlacesTimeoutMs,
    });
    this.logger.log(
      `places city=${query.cityName} candidates=${candidates.length} ms=${Date.now() - started}`,
    );
    if (!candidates.length) return [];

    const ordered = await this.rank(candidates, query);
    const picked = ordered.slice(0, query.limit);
    const namesEn = await this.englishNames(picked, query);

    return this.withImages(picked, namesEn, query);
  }

  // ------------------------------------------------------- 2차: 모델이 순서를 정한다
  /**
   * 후보를 추천 순서로 다시 세운다. **목록 자체는 바뀌지 않는다.**
   *
   * 모델이 돌려준 place_id 중 후보에 없는 건 버리고, 모델이 빠뜨린 후보는 뒤에 붙인다.
   * 그래서 **모델이 헛돌아도 목록은 살아 있다** — 순서만 구글 기본값이 된다.
   */
  private async rank(
    candidates: PlaceCandidate[],
    query: AttractionQuery,
  ): Promise<PlaceCandidate[]> {
    const byId = new Map(candidates.map((c) => [c.placeId, c]));

    try {
      const result = await this.openai.respond({
        instructions: RANK_INSTRUCTIONS,
        effort: this.config.openaiRankEffort,
        format: RANK_SCHEMA,
        input: [
          `다음은 ${query.cityName} 관광지 후보 목록(JSON)이다.`,
          `처음 ${query.cityName} 에 가는 한국인 여행자에게 추천할 순서로 ${query.limit}곳을 골라라.`,
          '',
          '--- 후보 목록 (JSON) ---',
          JSON.stringify(candidates.map(forModel)),
        ].join('\n'),
      });

      const parsed = parseJsonLoose<{ place_ids?: unknown }>(result.text);
      const ids = Array.isArray(parsed?.place_ids) ? parsed.place_ids : [];
      const ordered: PlaceCandidate[] = [];
      const seen = new Set<string>();

      for (const id of ids) {
        const candidate = typeof id === 'string' ? byId.get(id) : undefined;
        // 후보에 없는 id 는 모델이 지어낸 것이다. 조용히 버린다.
        if (!candidate || seen.has(candidate.placeId)) continue;
        seen.add(candidate.placeId);
        ordered.push(candidate);
      }

      if (!ordered.length) {
        this.logger.warn(
          `rank produced nothing city=${query.cityName} text=${clip(result.text, LOG_TEXT)}`,
        );
        return candidates;
      }

      // 모델이 빠뜨린 후보는 뒤로. "더 보기" 가 있으므로 버리지 않는다.
      const rest = candidates.filter((c) => !seen.has(c.placeId));
      this.logger.log(
        `rank city=${query.cityName} picked=${ordered.length} rest=${rest.length} ms=${result.ms}`,
      );
      return [...ordered, ...rest];
    } catch (err) {
      // 순서를 못 정해도 목록은 나간다. 구글 순서가 최악은 아니다.
      this.logger.warn(`rank failed city=${query.cityName} err=${err}`);
      return candidates;
    }
  }

  // --------------------------------------------------- 3차: 사진용 영문명
  /** place_id → 영문명. 실패해도 빈 Map 이면 한국어로만 사진을 찾는다. */
  private async englishNames(
    picked: PlaceCandidate[],
    query: AttractionQuery,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (!picked.length) return names;

    try {
      const result = await this.openai.respond({
        instructions: NAMES_INSTRUCTIONS,
        effort: this.config.openaiParseEffort,
        format: NAMES_SCHEMA,
        input: JSON.stringify(
          picked.map((c) => ({ place_id: c.placeId, name: c.name, city: query.cityName })),
        ),
      });

      const parsed = parseJsonLoose<{ names?: { place_id?: unknown; name_en?: unknown }[] }>(
        result.text,
      );
      for (const row of parsed?.names ?? []) {
        const id = text(row.place_id);
        const nameEn = text(row.name_en);
        if (id && nameEn) names.set(id, nameEn);
      }
      this.logger.log(`names city=${query.cityName} got=${names.size}/${picked.length}`);
    } catch (err) {
      // 영문명이 없으면 커버리지가 떨어질 뿐이다. 추천은 그대로 나간다.
      this.logger.warn(`names failed city=${query.cityName} err=${err}`);
    }
    return names;
  }

  // ------------------------------------------------------- 4차: 사진
  /**
   * 카드에 넣을 사진을 위키미디어에서 찾는다.
   *
   * ⚠️ **구글 사진을 쓰지 않는다.** 주소가 만료되는데 카카오 카드는 단톡방에 영구히
   *    남는다 — 며칠 뒤 깨진 자리가 남는다. 위키미디어 주소는 안 죽는다.
   *
   * 여러 곳을 **동시에** 찾고, 결과는 검색 캐시에 같이 저장되므로 같은 도시를 다시
   * 물어도 API 를 또 치지 않는다. 실패는 조용히 넘긴다 — 사진은 있으면 좋은 것이다.
   */
  private async withImages(
    picked: PlaceCandidate[],
    namesEn: Map<string, string>,
    query: AttractionQuery,
  ): Promise<Attraction[]> {
    const images = this.config.attractionImages;
    // 영어판·커먼즈 검색어에 쓸 도시명. 슬러그가 이미 영문이다.
    const cityNameEn = query.citySlug.replace(/-/g, ' ');

    return Promise.all(
      picked.map(async (candidate) => {
        const nameEn = namesEn.get(candidate.placeId) ?? null;
        const found: FoundImage | null = images
          ? await findAttractionImage(
              candidate.name,
              nameEn,
              query.cityName,
              cityNameEn,
              this.config.attractionImageTimeoutMs,
            )
          : null;

        if (images && !found) this.logger.log(`no image attraction=${candidate.name}`);
        // 어느 판에서 건졌는지 남긴다 — 커먼즈를 더한 게 값을 하는지는 이 비율로 본다.
        if (found) {
          this.logger.log(
            `image ${found.lang} attraction=${candidate.name} doc=${found.title}`,
          );
        }

        return toAttraction(candidate, query, nameEn, found?.url ?? null);
      }),
    );
  }
}

/** 모델에게 보여줄 최소한. **place_id 와 판단 재료만** 준다. */
function forModel(c: PlaceCandidate) {
  return {
    place_id: c.placeId,
    name: c.name,
    category: c.category,
    area: c.area,
    rating: c.rating,
    reviews: c.userRatingCount,
  };
}

export function toAttraction(
  c: PlaceCandidate,
  query: AttractionQuery,
  nameEn: string | null,
  imageUrl: string | null,
): Attraction {
  return {
    placeId: c.placeId,
    name: c.name,
    citySlug: query.citySlug,
    category: c.category,
    area: c.area,
    address: c.address,
    lat: c.lat,
    lng: c.lng,
    rating: c.rating,
    userRatingCount: c.userRatingCount,
    nameEn,
    imageUrl,
    // 신원을 알고 있으므로 검색이 아니라 그 장소를 정확히 연다.
    mapUrl: mapsUrl(c.name, query.cityName, c.placeId),
  };
}

import { Inject, Injectable, Logger } from '@nestjs/common';

import { mapsUrl } from '../../../common/maps-url';
import { positiveInt, text } from '../../../common/parse';
import { AppConfig, CONFIG } from '../../../config/app.config';
import { OpenAiService } from '../../openai/openai.service';
import { TwoStageSearch, newTwoStageTrace } from '../../openai/two-stage';
import { FoundImage, findAttractionImage } from '../attraction-image';
import { FoundPlace, findPlace } from '../attraction-place';
import { Attraction, AttractionProvider, AttractionQuery } from '../attraction.types';

/**
 * gpt-5-mini + 웹 검색으로 관광지를 찾는 provider.
 *
 *   1차 호출 : 웹 검색을 돌려 후보 15곳을 긁는다 (구조화 JSON)
 *   2차 호출 : 유명세·카테고리·동선을 섞어 상위 N곳을 고른다
 *
 * 호텔·항공권과 같은 2단 구조다. 이유도 같다 — 한 번에 시키면 모델이 검색 결과를
 * 요약하는 데 힘을 쓰고 비교·선별은 대충 한다. 여기서는 2차가 하는 일이 하나 더
 * 있는데, **카테고리를 섞는 것**이다. 그냥 두면 신사 다섯 곳이 나온다.
 *
 * 예약 도메인과 달리 **URL 을 모델에게 받지 않는다.** 지도 링크는 이름+도시로
 * 우리가 만든다([maps-url.ts](../../../common/maps-url.ts)). 그래서
 *   · 허용 호스트 목록이 없고
 *   · 링크가 죽었는지 확인할 일이 없고
 *   · 모델이 지어낸 주소로 사용자가 404 를 보는 일도 없다
 * 이 도메인에서 가장 중요한 단순화다.
 *
 * ⚠️ 느리다(합쳐서 7~30초). 카카오 5초 예산 안에서 부르면 안 된다.
 *    AttractionService 가 콜백/백그라운드에서만 호출한다.
 */

const SEARCH_INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 관광지 리서치 어시스턴트다.',
  '반드시 web_search 툴로 실제 웹을 검색해서 답한다. 기억에 의존하지 않는다.',
  '실제로 존재하고 지금 방문할 수 있는 곳만 적는다. 폐관·철거된 곳은 제외한다.',
  // ⚠️ 이름은 두 가지를 동시에 만족해야 한다. 한쪽만 시키면 다른 쪽이 무너진다.
  //    · 카드에 찍히는 글자다 → **한국어**여야 하고 40자를 넘으면 잘린다
  //    · 그대로 구글맵 검색어가 된다 → 설명이 붙으면 검색이 실패한다
  //    "공식 명칭만" 이라고만 시켰더니 'Umeda Sky Building Kuchu Teien Observatory' 가
  //    나와서 카드에서 잘렸고, 한국어만 시켰더니 '오사카 과학관/가족 체험 공간' 처럼
  //    설명이 붙었다. 둘 다 명시해야 한다.
  '관광지 이름은 **한국어 표기**로, **그 장소의 이름만** 적는다 ("오사카성", "도톤보리").',
  '영문명을 쓰지 마라. 한국인이 부르는 이름이 있으면 그것을 쓴다 (Osaka Castle → 오사카성).',
  '이름에 설명·영문 병기·슬래시·부연을 붙이지 마라. 지도에서 검색되는 이름 그대로여야 한다.',
  '이름이 20자를 넘지 않게 한다. 길면 카드에서 잘린다.',
  // 카드에는 안 쓰이는 값이다. 위키백과 영어판에서 사진을 찾는 데만 쓴다 —
  // 한국어 문서가 없는 관광지(동남아에 특히 많다)는 영문명이 유일한 단서다.
  '영문명(name_en)은 **영어 위키백과에 실릴 만한 공식 표기**로 따로 적는다 (Magellan\'s Cross).',
  '영문명을 모르면 지어내지 말고 null 로 둔다.',
  // ⚠️ 환산을 시켰더니 1,200엔 오사카성이 '5,760원', 2,700엔 카이유칸이 '2,700원'
  //    으로 나왔다. 모델은 환율 계산을 못한다. 적힌 숫자를 옮기는 것만 시킨다.
  '입장료는 성인 1인 기준을 **현지 통화 그대로** 적고 통화 코드(JPY, THB …)를 함께 낸다.',
  '**원화로 환산하지 마라.** 환율 계산을 하지 말고 검색 결과에 적힌 숫자를 그대로 옮긴다.',
  '무료면 free 를 true 로 두고 금액은 null 로 둔다.',
  '검색 결과에서 확인하지 못한 입장료는 지어내지 말고 null 로 둔다.',
  // 소요 시간은 원래 추정치다. "보통 얼마나 걸리나" 는 사실 확인 대상이 아니라
  // 일반적인 관람 시간이므로, 가격과 달리 상식 범위의 추정을 허용한다.
  '소요 시간은 일반적인 관람 시간을 분 단위로 적는다 (추정해도 된다).',
  '위치(area)는 **가장 가까운 역이나 번화가 이름**을 짧게 적는다 ("난바", "우메다").',
  '위치에 도시 이름을 넣지 마라 ("오사카 우메다" 가 아니라 "우메다").',
  '위치가 확실하지 않으면 지어내지 말고 null 로 둔다.',
  // ⚠️ 이 문단을 지우지 마라. 없으면 모델이 "검색을 진행해도 될까요?" 라고 되묻고 끝난다.
  //    상대는 사람이 아니라 프로그램이라 그 질문에 답해줄 사람이 없다.
  '**절대 되묻지 마라.** 확인을 구하거나 진행 여부를 묻지 말고 즉시 검색해서 결과만 낸다.',
  '인사말·서론·맺음말·계획 설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

/**
 * 입장료에 허용하는 통화.
 *
 * enum 으로 가두는 이유: 자유 문자열로 두면 모델이 '엔', '¥', 'yen' 을 섞어 준다.
 * 그러면 카드 문구를 만들 때마다 표기 변형을 뒤쫓게 된다. ISO 4217 만 받는다.
 */
export const CURRENCIES = [
  'JPY', 'KRW', 'USD', 'EUR', 'CNY', 'THB', 'VND', 'TWD', 'HKD', 'SGD', 'PHP', 'GBP',
];

/** 카드에 노출되고 2차 호출이 섞어야 하는 축. 프롬프트와 스키마가 같은 값을 쓴다. */
export const CATEGORIES = [
  '역사/문화',
  '자연/공원',
  '테마파크',
  '거리/쇼핑',
  '전망',
  '미술관/박물관',
  '음식/시장',
  '체험',
];

/**
 * 두 호출이 주고받는 필드. **여기 한 번만 적는다.**
 *
 * ⚠️ 이 표가 있는 이유는 줄 수가 아니다. **1차 스키마에 없는 필드는 2차가 절대 못
 *    채운다** — 2차는 "후보에 없는 건 null" 규칙을 지키기 때문이다. 스키마를 두 벌
 *    따로 적으면 한쪽에만 필드를 넣는 일이 생기고, 그러면 그 칸은 영원히 null 로
 *    나가면서 아무 에러도 내지 않는다. duration_minutes 와 호텔 썸네일이 정확히
 *    그래서 비어 있었다. 한 곳에서 파생시키면 빠뜨릴 자리가 없다.
 *
 * 설명(description)만 단계마다 다르다. 1차는 "웹에서 찾아라", 2차는 "후보에 적힌
 * 값을 옮겨라" 라고 시켜야 해서다 — 같은 필드에 같은 말을 시키면 2차가 가격을
 * 새로 지어낸다. 그래서 설명은 두 벌, 필드는 한 벌이다.
 */
type Stage = 'candidate' | 'pick';

interface SharedField {
  /** 두 호출이 똑같이 쓰는 부분 (type·enum). 여기가 갈리면 2차가 후보를 못 읽는다. */
  base: Record<string, unknown>;
  /** 단계별 지시문. null 이면 설명 없이 낸다 (카테고리는 enum 이 곧 설명이다). */
  description: Record<Stage, string | null>;
}

const SHARED_FIELDS: Record<string, SharedField> = {
  name: {
    base: { type: 'string' },
    description: {
      candidate: '관광지명 (한국어 표기, 장소 이름만)',
      pick:
        '관광지명. **한국어 표기**로 장소 이름만 (20자 이내). 영문명·설명·괄호 금지. ' +
        '이 값이 그대로 카드 제목이자 구글맵 검색어가 된다',
    },
  },
  name_en: {
    base: { type: ['string', 'null'] },
    description: {
      candidate: '영어 위키백과에 실릴 만한 공식 영문명. 모르면 null',
      pick:
        '공식 영문명 (Osaka Castle, Magellan\'s Cross). 카드에는 안 쓰고 ' +
        '사진 검색에만 쓴다. 후보에 있으면 그 값을, 없으면 아는 대로 채운다. 모르면 null',
    },
  },
  category: {
    base: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
    description: { candidate: null, pick: null },
  },
  area: {
    base: { type: ['string', 'null'] },
    description: {
      candidate: '가장 가까운 역·번화가 이름 (도시 이름 제외)',
      pick: '가장 가까운 역·번화가 이름. 도시 이름은 빼고 짧게 (난바, 우메다). 모르면 null',
    },
  },
  free: {
    base: { type: ['boolean', 'null'] },
    description: { candidate: '입장료가 없으면 true', pick: '입장료가 없으면 true' },
  },
  admission_fee: {
    base: { type: ['integer', 'null'] },
    description: {
      candidate: '성인 1인 입장료. **현지 통화 그대로, 환산 금지.** 무료이거나 모르면 null',
      pick:
        '성인 1인 입장료. **현지 통화 그대로 적는다 — 원화로 환산하지 마라.** ' +
        '무료이거나 확인 못 했으면 null',
    },
  },
  admission_currency: {
    base: { type: ['string', 'null'], enum: [...CURRENCIES, null] },
    description: {
      candidate: 'admission_fee 의 통화 코드. 금액이 있으면 반드시 채운다',
      pick: 'admission_fee 의 통화 코드 (일본이면 JPY). 금액이 있으면 반드시 채운다',
    },
  },
  duration_minutes: {
    base: { type: ['integer', 'null'] },
    description: {
      candidate: '일반적인 관람 소요 시간(분). 추정해도 된다',
      pick: '둘러보는 데 걸리는 일반적인 관람 시간(분). 후보에 있으면 그 값을, 없으면 추정해서 채운다',
    },
  },
};

/**
 * 한쪽 단계에만 있는 필드.
 *
 * `note` 는 1차가 후보를 추릴 근거로 적어두는 메모라 카드까지 갈 일이 없고,
 * `description`·`tags` 는 2차가 고른 다음에야 쓸 수 있다. **공유 필드와 달리
 * 여기 있는 것들은 한쪽에 없어도 정상이다** — 그래서 위 표와 갈라 둔다.
 */
const OWN_FIELDS: Record<string, Record<string, unknown>> = {
  note: { type: ['string', 'null'], description: '특징 한 줄' },
  description: { type: ['string', 'null'], description: '한 줄 소개' },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: '특징 키워드 (야경, 아이동반, 실내 등)',
  },
};

/** 1차가 받는 필드. 순서가 곧 스키마 순서다. */
const CANDIDATE_FIELDS = [
  'name',
  'name_en',
  'category',
  'area',
  'free',
  'admission_fee',
  'admission_currency',
  'duration_minutes',
  'note',
] as const;

/** 2차가 받는 필드. 공유 필드는 1차와 같고 note 자리에 description·tags 가 온다. */
const PICK_FIELDS = [
  'name',
  'name_en',
  'category',
  'area',
  'description',
  'free',
  'admission_fee',
  'admission_currency',
  'duration_minutes',
  'tags',
] as const;

/**
 * 관광지 1건의 스키마. strict 라 **모든 키가 required 여야** 해서 순서 목록이 곧 required 다.
 */
function itemSchema(stage: Stage, fields: readonly string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of fields) {
    const shared = SHARED_FIELDS[key];
    if (!shared) {
      properties[key] = OWN_FIELDS[key];
      continue;
    }
    // 항상 복사본을 만든다. 두 스키마가 같은 객체를 가리키면 한쪽을 손댄 게
    // 다른 쪽까지 바꾸는데, 그건 이 파일이 막으려는 바로 그 사고의 역방향이다.
    const description = shared.description[stage];
    properties[key] = description ? { ...shared.base, description } : { ...shared.base };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: [...fields],
    properties,
  };
}

/**
 * 1차 호출도 구조화 출력을 건다.
 *
 * 자유 텍스트로 두면 모델이 "이렇게 정리해 드리겠습니다. 진행할까요?" 같은 문장을
 * 내놓고 끝난다 — 호텔 쪽에서 실제로 그래서 후보가 0개가 된 적 있다.
 */
export const ATTRACTION_CANDIDATE_SCHEMA = {
  type: 'json_schema' as const,
  name: 'attraction_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: { type: 'array', items: itemSchema('candidate', CANDIDATE_FIELDS) },
    },
  },
};

/** 2차 호출에 거는 구조화 출력 스키마. */
export const ATTRACTION_SCHEMA = {
  type: 'json_schema' as const,
  name: 'attraction_picks',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['attractions'],
    properties: {
      attractions: { type: 'array', items: itemSchema('pick', PICK_FIELDS) },
    },
  },
};

const RANK_INSTRUCTIONS = [
  '너는 관광지 후보를 비교해 추천 목록을 만드는 어시스턴트다.',
  '주어진 후보 목록 안에서만 고른다. 목록에 없는 곳을 새로 만들지 않는다.',
  '후보에 적히지 않은 입장료는 null 로 둔다. 추측하거나 환산해서 채우지 않는다.',
  '입장료 금액과 통화 코드는 후보에 적힌 값을 그대로 옮긴다.',
  // duration 만 예외인 이유: "보통 얼마나 걸리나" 는 사실 확인 대상이 아니라 상식이다.
  // 이 예외를 안 적으면 "후보에 없으면 null" 규칙에 걸려 소요 시간이 전부 비어 나간다.
  '소요 시간은 예외다 — 후보에 없어도 일반적인 관람 시간을 추정해서 채운다.',
  '영문명(name_en)도 예외다 — 후보에 없어도 아는 공식 영문명이 있으면 채운다.',
  // 이걸 안 시키면 신사 다섯 곳, 전망대 다섯 곳이 나온다.
  '**카테고리를 반드시 섞어라.** 같은 성격의 장소를 연달아 고르지 않는다.',
  '처음 가는 사람 기준으로, 그 도시에 갔으면 봐야 할 곳을 앞에 둔다.',
  '**요청한 개수를 반드시 채워라.** 후보가 그만큼 없으면 있는 것을 전부 낸다 — 임의로 줄이지 마라.',
].join(' ');

interface RawPick {
  name?: unknown;
  category?: unknown;
  name_en?: unknown;
  area?: unknown;
  description?: unknown;
  free?: unknown;
  admission_fee?: unknown;
  admission_currency?: unknown;
  duration_minutes?: unknown;
  tags?: unknown;
}

@Injectable()
export class OpenAiAttractionProvider
  extends TwoStageSearch<AttractionQuery>
  implements AttractionProvider
{
  readonly name = 'openai';
  protected readonly logger = new Logger(OpenAiAttractionProvider.name);
  protected readonly label = 'attraction';

  protected readonly searchInstructions = SEARCH_INSTRUCTIONS;
  protected readonly candidateSchema = ATTRACTION_CANDIDATE_SCHEMA;
  protected readonly rankInstructions = RANK_INSTRUCTIONS;
  protected readonly pickSchema = ATTRACTION_SCHEMA;
  protected readonly pickKey = 'attractions';

  constructor(@Inject(CONFIG) config: AppConfig, openai: OpenAiService) {
    super(config, openai);
  }

  protected subjectOf(query: AttractionQuery): string {
    return `city=${query.cityName}`;
  }

  protected searchInput(query: AttractionQuery, wanted: number): string {
    return [
      `${query.cityName} 에서 가볼 만한 관광지 ${wanted}곳을 지금 웹에서 검색해 찾아라.`,
      `카테고리가 겹치지 않게 다양하게 모아라: ${CATEGORIES.join(', ')}.`,
      '유명한 곳과 현지에서 평이 좋은 곳을 섞어라.',
      '확인 못 한 항목은 null 로 둔다. 되묻지 말고 바로 결과를 낸다.',
    ].join('\n');
  }

  protected rankInput(query: AttractionQuery, candidates: string): string {
    return [
      `다음은 ${query.cityName} 관광지 후보 목록(JSON)이다.`,
      `처음 ${query.cityName} 에 가는 한국인 여행자에게 추천할 ${query.limit}곳을 골라라.`,
      '유명세·특색·카테고리를 고려하되, 같은 카테고리를 연달아 고르지 마라.',
      '',
      '--- 후보 목록 (JSON) ---',
      candidates,
    ].join('\n');
  }

  /**
   * 1차(후보) → 2차(선별) → 3차(사진). 한 단계라도 빈손이면 거기서 끝낸다.
   *
   * 호텔·항공권에는 이것 말고 `searchTraced()` 가 하나 더 있는데(테스트가 썸네일
   * 계측을 읽는다), 관광지에는 **읽는 쪽이 없어서 두지 않는다.** 계측은
   * TwoStageSearch 가 로그로 남기므로 trace 는 두 단계에 넘기기만 한다.
   */
  async search(query: AttractionQuery): Promise<Attraction[]> {
    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 관광지 검색을 건너뛴다');
      return [];
    }

    const trace = newTwoStageTrace();
    const candidates = await this.findCandidates(query, trace);
    // 후보가 없으면 2차를 부르지 않는다 — 빈손에서 고르라고 하면 모델이 지어낸다.
    if (!candidates) return [];

    const picks = await this.rank<RawPick>(query, candidates, trace);
    return this.enrich(this.toAttractions(picks, query), query);
  }

  // --------------------------------------------- 3차: 사진 + 사실 데이터
  /**
   * 모델이 고른 곳들에 **사진과 사실 데이터를 채운다.**
   *
   *   사진      위키백과 ([attraction-image.ts](../attraction-image.ts)) — 무료
   *   사실      구글 Places ([attraction-place.ts](../attraction-place.ts)) — 유료
   *
   * 둘 다 **모델에게 안 묻는 값**이라는 점이 같다. 모델은 이미지 주소도 좌표도
   * 그럴듯하게 지어내는데, 구조화된 API 에서 받아오면 지어낼 자리가 없다 —
   * 지도 링크를 우리가 만드는 것과 같은 이유다.
   *
   * ⚠️ **한 관광지에 대해 두 호출을 나란히 태운다.** 단계로 나눠 돌리면 대기 시간이
   *    두 배가 된다. 콜백 경로라 5초 예산과는 무관하지만, 사용자는 그만큼 더 기다린다.
   *
   * ⚠️ 실패는 조용히 넘긴다. 사진도 주소도 있으면 좋은 것이지 없으면 안 되는 것이
   *    아니다 — 위키백과나 구글이 느리다고 관광지 추천이 통째로 실패하면 안 된다.
   *
   * **Places 에도 사진이 있지만 위키백과를 쓴다.** 구글 사진은 받아오는 호출이 따로
   * 과금되는데, 위키백과는 공짜이고 실측 커버리지가 87% 다.
   */
  private async enrich(
    attractions: Attraction[],
    query: AttractionQuery,
  ): Promise<Attraction[]> {
    const images = this.config.attractionImages;
    // 키가 없으면 0곳 — 설정으로 끄는 스위치를 따로 두지 않는다. 키가 곧 스위치다.
    const placeLimit = this.config.googlePlacesApiKey ? this.config.googlePlacesLimit : 0;
    if (!images && !placeLimit) return attractions;

    // 영어판 검색어에 쓸 도시명. 슬러그가 이미 영문이다 (ho-chi-minh → ho chi minh).
    const cityNameEn = query.citySlug.replace(/-/g, ' ');

    return Promise.all(
      attractions.map(async (attraction, index) => {
        const [image, place] = await Promise.all([
          images ? this.imageFor(attraction, query.cityName, cityNameEn) : null,
          // ⚠️ 상위 N 곳만 조회한다. 평점·운영시간을 켜면 티어가 올라가 무료 한도가
          //    훨씬 작아지므로, 건수를 줄이는 손잡이가 여기다.
          index < placeLimit ? this.placeFor(attraction, query.cityName) : null,
        ]);

        return {
          ...attraction,
          imageUrl: image ?? attraction.imageUrl,
          ...(place && {
            placeId: place.placeId,
            address: place.address,
            lat: place.lat,
            lng: place.lng,
            rating: place.rating,
            userRatingCount: place.userRatingCount,
            openingHours: place.openingHours,
            website: place.website,
            // 신원을 알았으니 이제 검색이 아니라 그 장소를 정확히 연다.
            mapUrl: mapsUrl(attraction.name, query.cityName, place.placeId),
          }),
        };
      }),
    );
  }

  private async imageFor(
    attraction: Attraction,
    cityName: string,
    cityNameEn: string,
  ): Promise<string | null> {
    const found: FoundImage | null = await findAttractionImage(
      attraction.name,
      attraction.nameEn,
      cityName,
      cityNameEn,
      this.config.attractionImageTimeoutMs,
    );
    if (!found) {
      this.logger.log(`no image attraction=${attraction.name}`);
      return null;
    }

    // 어느 언어판에서 건졌는지 남긴다 — 영문명을 받는 게 값을 하는지는
    // 이 로그의 ko/en 비율로 본다 (실측 커버리지 ko 62% → ko+en 87%).
    this.logger.log(`image ${found.lang} attraction=${attraction.name} doc=${found.title}`);
    return found.url;
  }

  private async placeFor(
    attraction: Attraction,
    cityName: string,
  ): Promise<FoundPlace | null> {
    const found = await findPlace(attraction.name, cityName, {
      apiKey: this.config.googlePlacesApiKey,
      timeoutMs: this.config.googlePlacesTimeoutMs,
      ratings: this.config.googlePlacesRatings,
    });
    if (!found) {
      // 못 찾는 건 흔하다. 모델이 지어낸 이름이거나, 구글에 없는 소규모 장소다.
      this.logger.log(`no place attraction=${attraction.name}`);
      return null;
    }

    this.logger.log(
      `place attraction=${attraction.name} id=${found.placeId} ` +
        `rating=${found.rating ?? '-'} hours=${found.openingHours ? 'y' : 'n'}`,
    );
    return found;
  }

  // ------------------------------------------------------------ 정규화
  private toAttractions(picks: RawPick[], query: AttractionQuery): Attraction[] {
    const attractions: Attraction[] = [];

    for (const pick of picks) {
      // 이름이 없으면 지도 검색어를 만들 수 없다. 관광지에서 유일한 필수값이다.
      const name = placeName(pick.name);
      if (!name) continue;

      const free = typeof pick.free === 'boolean' ? pick.free : null;
      // 통화를 모르면 금액도 버린다. 숫자만 남기면 카드에서 '1,200' 이 되는데
      // 한국인은 그걸 원으로 읽는다 — 엔이면 10배를 틀리는 셈이다.
      const currency = currencyOf(pick.admission_currency);
      const admissionFee = currency ? positiveInt(pick.admission_fee) : null;

      attractions.push({
        name,
        // 카드에는 안 쓴다. 위키백과 영어판 검색어로만 쓰인다.
        nameEn: text(pick.name_en),
        citySlug: query.citySlug,
        category: category(pick.category),
        area: area(pick.area, query.cityName),
        description: text(pick.description),
        // 입장료가 잡혔으면 무료일 수 없다. 모델이 free:true 와 금액을 같이 주기도 한다.
        free: admissionFee ? false : free,
        admissionFee,
        admissionCurrency: admissionFee ? currency : null,
        durationMinutes: positiveInt(pick.duration_minutes),
        // 여기가 이 도메인의 핵심 — 링크를 모델에게 받지 않고 우리가 만든다.
        mapUrl: mapsUrl(name, query.cityName),
        source: 'ai',
        tags: Array.isArray(pick.tags)
          ? pick.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          : [],
      });
    }

    return attractions.slice(0, query.limit);
  }
}

// ------------------------------------------------------------------ 헬퍼
/**
 * 지도에서 검색되는 이름만 남긴다.
 *
 * 프롬프트로 시켜도 모델은 이름에 설명을 붙인다 — 실측한 것들:
 *   '오사카 난바 파크스/Namba Parks 쇼핑 & 레저' → '오사카 난바 파크스'
 *   '오사카 과학관/가족 체험 공간'                → '오사카 과학관'
 *   '유니버설 스튜디오 재팬(USJ)'                 → '유니버설 스튜디오 재팬'
 *
 * **이름이 곧 검색어이자 항목의 신원**이라 여기서 흔들리면 지도가 엉뚱한 곳을 열고
 * 중복 제거도 안 된다. 잘라낸 게 전부면 원문을 그대로 쓴다 — 이름이 없는 것보단 낫다.
 */
export function placeName(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const trimmed = raw
    .split('/')[0] // 병기·부연은 슬래시 뒤에 온다
    .replace(/[(（][^)）]*[)）]\s*$/, '') // 끝의 괄호 설명
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed || raw;
}

/**
 * 위치 표기를 정리한다.
 *
 * 도시 이름만 오는 경우가 있는데('오사카'), 그건 카드에서 아무 정보도 아니다 —
 * 사용자는 이미 그 도시를 물어봤다. 앞에 붙은 도시 이름도 떼어낸다
 * ('오사카시 스미노에구' → '스미노에구'). 남는 게 없으면 null.
 */
export function area(value: unknown, cityName: string): string | null {
  const raw = text(value);
  if (!raw) return null;

  // 이름과 마찬가지로 슬래시 병기가 섞여 온다 ('앙깡/시내', '샌세/류').
  // 앞 조각만 남긴다 — 두 개를 다 보여줘도 40자만 먹고 더 정확해지지 않는다.
  const first = raw.split('/')[0].trim();
  if (!cityName) return first || null;

  const city = cityName.replace(/시$/, '');
  const stripped = first.replace(new RegExp(`^${city}(시|부)?\\s*`), '').trim();
  return stripped || null;
}

/** 아는 통화 코드만 통과시킨다. '엔', '¥', 'yen' 은 전부 버린다. */
function currencyOf(value: unknown): string | null {
  const raw = text(value)?.toUpperCase();
  return raw && CURRENCIES.includes(raw) ? raw : null;
}

/** 아는 카테고리만 통과시킨다. 모델이 '관광' 같은 걸 만들면 카드 문구가 무의미해진다. */
function category(value: unknown): string | null {
  const raw = text(value);
  return raw && CATEGORIES.includes(raw) ? raw : null;
}

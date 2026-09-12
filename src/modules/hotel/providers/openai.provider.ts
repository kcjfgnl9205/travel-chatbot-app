import { Inject, Injectable, Logger } from '@nestjs/common';

import { allowedHost, merchantFrom, toKoreanUrl } from '../../../common/booking-url';
import { AppConfig, CONFIG } from '../../../config/app.config';
import { OpenAiService, parseJsonLoose } from '../../openai/openai.service';
import { Hotel, HotelProvider, HotelQuery } from '../hotel.types';
import { ThumbnailSource, extractThumbnail } from '../thumbnail';

/**
 * gpt-5-mini + 웹 검색으로 호텔을 찾는 provider.
 *
 *   1차 호출 : 웹 검색을 돌려 후보 10~20개를 긁는다 (구조화 JSON)
 *   2차 호출 : 후보를 조건·가격·위치·평점으로 비교해 상위 N개를 JSON 으로 뽑는다
 *
 * 왜 두 번 부르나 — 한 번에 시키면 모델이 검색 결과를 요약하는 데 힘을 쓰고
 * 비교/선별은 대충 한다. 검색과 판단을 갈라두면 각 단계를 따로 계측·디버깅할 수 있다.
 *
 * ⚠️ **두 호출 다 구조화 출력을 건다.** 1차를 자유 텍스트로 뒀더니 모델이
 *    "웹 검색을 진행해도 될까요? 날짜를 알려주세요" 라고 되묻고 끝나서 후보가 0개가 됐다.
 *    상대는 사람이 아니라 프로그램이라 그 질문에 답할 사람이 없다.
 *
 * ⚠️ 느리다(합쳐서 7~30초). 카카오 5초 예산 안에서 부르면 안 된다.
 *    HotelService 가 콜백/백그라운드에서만 호출한다.
 */

/**
 * 예약 링크로 인정하는 호스트.
 *
 * 모델은 없는 URL 을 그럴듯하게 만들어낸다. 그게 애드픽 변환을 타고 사용자에게
 * 나가면 404 로 떨어진다. 호스트라도 걸러서 피해를 줄인다.
 *
 * ⚠️ 여기를 바꾸면 SEARCH_INSTRUCTIONS 와 HOTEL_SCHEMA 의 안내 문구도 같이 바꿔야 한다.
 *    모델에게 A 를 찾으라고 시켜놓고 B 만 통과시키면 결과가 전부 버려진다.
 */
export const ALLOWED_HOSTS = [
  'trip.com', // 트립닷컴
  'myrealtrip.com', // 마이리얼트립
  'klook.com', // 클룩
  'hotels.com', // 호텔스닷컴
];

/** 프롬프트에 그대로 박아 넣는 표기. 목록과 문구가 어긋나지 않게 여기서 만든다. */
export const ALLOWED_SITES_TEXT =
  '트립닷컴(trip.com), 마이리얼트립(myrealtrip.com), 클룩(klook.com), 호텔스닷컴(hotels.com)';

/** 호텔 예약 링크로 인정하는가. 호스트 규칙은 항공권과 공유한다. */
export function isAllowedSourceUrl(url: string): boolean {
  return allowedHost(url, ALLOWED_HOSTS);
}

/**
 * 예약 링크를 한국어 페이지로 돌린다 (호스트/쿼리만 손댄다).
 * 규칙은 [booking-url.ts](../../../common/booking-url.ts) 에 있다 — 항공권도 같은 규칙을 쓴다.
 */
export { chooseUrl, toKoreanUrl } from '../../../common/booking-url';

/** 2차 호출에 거는 구조화 출력 스키마. strict 라 모든 키가 required 여야 한다. */
export const HOTEL_SCHEMA = {
  type: 'json_schema' as const,
  name: 'hotel_picks',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hotels'],
    properties: {
      hotels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'name',
            'source_url',
            'merchant',
            'address',
            'star_rating',
            'review_score',
            'price_from',
            'thumbnail_url',
            'description',
            'tags',
          ],
          properties: {
            name: { type: 'string', description: '한국어 호텔명. 없으면 영문 그대로' },
            source_url: {
              type: 'string',
              description:
                `검색 결과에 실제로 나온 예약 페이지 URL. ${ALLOWED_SITES_TEXT} 중 하나여야 한다. ` +
                '한국어 페이지 주소를 쓴다',
            },
            merchant: {
              type: ['string', 'null'],
              description: 'trip | myrealtrip | klook | hotels',
            },
            address: { type: ['string', 'null'] },
            star_rating: { type: ['number', 'null'], description: '1~5' },
            review_score: { type: ['number', 'null'], description: '10점 만점' },
            price_from: {
              type: ['integer', 'null'],
              description: '1박 최저가(원). 검색 결과에서 확인한 값만. 모르면 null',
            },
            thumbnail_url: {
              type: ['string', 'null'],
              description: '검색 결과에 실제로 나온 이미지 URL. 모르면 null',
            },
            description: { type: ['string', 'null'] },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '지역/특징 키워드. 첫 번째가 카드에 노출되므로 지역명을 앞에',
            },
          },
        },
      },
    },
  },
};

/**
 * 검색 한 번에 대한 계측.
 *
 * 응답 경로에서는 아무도 안 본다 — 진단용 엔드포인트(/api/v1/debug/hotel-search)가
 * "어디서 몇 초가 녹았는지"를 보여주려고 모은다. 로그에도 같은 값이 찍힌다.
 */
export interface SearchTrace {
  searchMs: number;
  rankMs: number;
  thumbnailMs: number;
  totalMs: number;
  /** 모델이 web_search 를 실제로 돌린 횟수. 0 이면 기억으로 답한 것이다. */
  searchCalls: number;
  candidateChars: number;
  /** 1차 호출이 모아온 후보 개수. 0 이면 검색 프롬프트가 안 먹은 것이다. */
  candidates: number;
  /** 2차 호출이 고른 개수 (필터 전). */
  picks: number;
  droppedUntrusted: number;
  /** 살아 있지 않아서 버린 이미지 주소 수. */
  droppedThumbnails: number;
  /** 최종적으로 이미지가 붙은 호텔 수. */
  thumbnails: number;
  /** 어느 층에서 건졌는지 (og / ld / photo). 층별 성공률을 봐야 손볼 데가 보인다. */
  thumbnailSources: Record<string, number>;
  hotels: number;
}

export interface TracedSearch {
  hotels: Hotel[];
  trace: SearchTrace;
  /** 1차 호출의 원문. 모델이 뭘 긁어왔는지 눈으로 봐야 할 때가 있다. */
  candidates: string | null;
}

interface RawPick {
  name?: unknown;
  source_url?: unknown;
  merchant?: unknown;
  address?: unknown;
  star_rating?: unknown;
  review_score?: unknown;
  price_from?: unknown;
  thumbnail_url?: unknown;
  description?: unknown;
  tags?: unknown;
}

const SEARCH_INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 호텔 리서치 어시스턴트다.',
  '반드시 web_search 툴로 실제 웹을 검색해서 답한다. 기억에 의존하지 않는다.',
  `예약 링크는 반드시 다음 네 곳 중 하나여야 한다: ${ALLOWED_SITES_TEXT}.`,
  '이 네 곳이 아닌 사이트(아고다·부킹닷컴 등)의 링크는 쓸 수 없으니 적지 마라.',
  // 사용자는 한국인이다. 영문 페이지가 뜨면 예약까지 못 간다.
  '**반드시 한국어 페이지 주소를 골라라.** 같은 호텔이라도 영문 페이지가 아니라 '
    + '한국어 페이지 URL 을 적는다 (예: www.trip.com 이 아니라 kr.trip.com, '
    + 'klook 은 /ko/ 경로, hotels.com 은 kr.hotels.com).',
  '검색 결과에 나오지 않은 URL·가격·평점은 절대 지어내지 않는다. 모르면 null 로 둔다.',
  // ⚠️ 이 문단을 지우지 마라. 없으면 모델이 "검색을 진행해도 될까요?" 라고 되묻고 끝난다.
  //    상대는 사람이 아니라 프로그램이라 그 질문에 답해줄 사람이 없다.
  '**절대 되묻지 마라.** 확인을 구하거나 진행 여부를 묻지 말고 즉시 검색해서 결과만 낸다.',
  '날짜가 주어지지 않았으면 특정 날짜를 묻지 말고 일반적인 요금대를 조사한다.',
  '인사말·서론·맺음말·계획 설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

/**
 * 1차 호출도 구조화 출력을 건다.
 *
 * 자유 텍스트로 두면 모델이 "이렇게 정리해 드리겠습니다. 진행할까요?" 같은 문장을
 * 내놓고 끝난다 — 실제로 그래서 후보가 0개가 된 적 있다. 스키마를 걸면 그럴 자리가 없다.
 */
export const CANDIDATE_SCHEMA = {
  type: 'json_schema' as const,
  name: 'hotel_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'url', 'price_from', 'review_score', 'area', 'note'],
          properties: {
            name: { type: 'string', description: '호텔명 (한국어, 영문 병기)' },
            url: {
              type: 'string',
              description:
                `검색 결과에 실제로 나온 예약 페이지 URL. ${ALLOWED_SITES_TEXT} 중 하나. ` +
                '반드시 한국어 페이지 (kr.trip.com, kr.hotels.com, klook.com/ko/ 등)',
            },
            price_from: { type: ['integer', 'null'], description: '1박 최저가(원). 확인된 값만' },
            review_score: { type: ['number', 'null'], description: '10점 만점' },
            area: { type: ['string', 'null'], description: '위치 (역/번화가 기준)' },
            note: { type: ['string', 'null'], description: '특징 한 줄' },
          },
        },
      },
    },
  },
};

const RANK_INSTRUCTIONS = [
  '너는 호텔 후보를 비교해 추천 목록을 만드는 어시스턴트다.',
  '주어진 후보 목록 안에서만 고른다. 목록에 없는 호텔을 새로 만들지 않는다.',
  '후보에 적히지 않은 URL·가격·평점은 null 로 둔다. 추측해서 채우지 않는다.',
  '후보의 URL 을 그대로 옮긴다. 임의로 도메인이나 경로를 바꾸지 않는다.',
  '**요청한 개수를 반드시 채워라.** 후보가 그만큼 없으면 있는 것을 전부 낸다 — 임의로 줄이지 마라.',
].join(' ');

@Injectable()
export class OpenAiHotelProvider implements HotelProvider {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiHotelProvider.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
  ) {}

  /** 키가 없으면 검색을 시도조차 하지 않는다. 호출부가 미리 알아야 한다. */
  get enabled(): boolean {
    return this.openai.enabled;
  }

  async search(query: HotelQuery): Promise<Hotel[]> {
    return (await this.searchTraced(query)).hotels;
  }

  /** search() 와 같은 흐름이되 단계별 소요 시간을 같이 돌려준다. */
  async searchTraced(query: HotelQuery): Promise<TracedSearch> {
    const started = Date.now();
    const trace: SearchTrace = {
      searchMs: 0,
      rankMs: 0,
      thumbnailMs: 0,
      totalMs: 0,
      searchCalls: 0,
      candidateChars: 0,
      candidates: 0,
      picks: 0,
      droppedUntrusted: 0,
      droppedThumbnails: 0,
      thumbnails: 0,
      thumbnailSources: {},
      hotels: 0,
    };
    const done = (hotels: Hotel[], candidates: string | null): TracedSearch => {
      trace.hotels = hotels.length;
      trace.totalMs = Date.now() - started;
      return { hotels, trace, candidates };
    };

    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 호텔 검색을 건너뛴다');
      return done([], null);
    }

    const candidates = await this.findCandidates(query, trace);
    if (!candidates) return done([], null);

    const picks = await this.rank(query, candidates, trace);
    trace.picks = picks.length;

    const normalized = this.toHotels(picks, query, trace);

    const thumbStarted = Date.now();
    const hotels = await this.withThumbnails(normalized, trace);
    trace.thumbnailMs = Date.now() - thumbStarted;

    return done(hotels, candidates);
  }

  // -------------------------------------------------- 1차: 웹 검색으로 후보 수집
  private async findCandidates(query: HotelQuery, trace: SearchTrace): Promise<string | null> {
    const wanted = this.config.openaiCandidateCount;
    const guests = query.guests ? `${query.guests}명이 묵을 예정이다. ` : '';

    const result = await this.openai.respond({
      instructions: SEARCH_INSTRUCTIONS,
      tools: [this.openai.webSearchToolSpec],
      effort: this.config.openaiSearchEffort,
      format: CANDIDATE_SCHEMA,
      input: [
        `${query.cityName} 에서 묵을 만한 호텔 ${wanted}곳을 지금 웹에서 검색해 찾아라.`,
        guests,
        '가격대와 지역이 겹치지 않게 다양하게 모아라.',
        '확인 못 한 항목은 null 로 둔다. 되묻지 말고 바로 결과를 낸다.',
      ].join('\n'),
    });

    trace.searchMs = result.ms;
    trace.searchCalls = result.searchCalls;
    trace.candidateChars = result.text.length;

    // 검색을 한 번도 안 돌았으면 모델이 기억으로 답한 것이다. URL 이 특히 위험하다.
    if (!result.searchCalls) {
      this.logger.warn(`web_search 가 호출되지 않았다 city=${query.cityName}`);
    }

    const parsed = parseJsonLoose<{ candidates?: unknown[] }>(result.text);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    trace.candidates = candidates.length;

    this.logger.log(
      `hotel search city=${query.cityName} searches=${result.searchCalls} ` +
        `candidates=${candidates.length} chars=${result.text.length} ms=${result.ms}`,
    );

    if (!candidates.length) {
      // 스키마를 걸어뒀는데도 비어 오면 프롬프트가 안 먹은 것이다. 원문을 남긴다.
      this.logger.warn(
        `hotel search produced no candidates city=${query.cityName} ` +
          `text=${result.text.slice(0, 200)}`,
      );
      return null;
    }
    return JSON.stringify(candidates);
  }

  // ------------------------------------------------ 2차: 비교 후 상위 N개 선정
  private async rank(
    query: HotelQuery,
    candidates: string,
    trace: SearchTrace,
  ): Promise<RawPick[]> {
    const guests = query.guests ? `투숙 인원은 ${query.guests}명이다.` : '';

    const result = await this.openai.respond({
      instructions: RANK_INSTRUCTIONS,
      effort: this.config.openaiRankEffort,
      format: HOTEL_SCHEMA,
      input: [
        `다음은 ${query.cityName} 호텔 후보 목록(JSON)이다.`,
        guests,
        `가격·위치·평점·특징을 비교해 가장 추천할 만한 ${query.limit}곳을 골라라.`,
        `예약 페이지 URL 이 없거나 ${ALLOWED_SITES_TEXT} 밖의 링크인 후보는 제외한다.`,
        '비슷한 호텔만 고르지 말고 가격대와 지역을 섞어라.',
        '',
        '--- 후보 목록 (JSON) ---',
        candidates,
      ].join('\n'),
    });

    trace.rankMs = result.ms;

    const parsed = parseJsonLoose<{ hotels?: RawPick[] }>(result.text);
    if (!parsed?.hotels?.length) {
      this.logger.warn(
        `hotel rank produced no picks city=${query.cityName} status=${result.status} ` +
          `text=${result.text.slice(0, 200)}`,
      );
      return [];
    }

    this.logger.log(
      `hotel rank city=${query.cityName} picks=${parsed.hotels.length} ms=${result.ms}`,
    );
    return parsed.hotels;
  }

  // ------------------------------------------------------------ 정규화
  private toHotels(picks: RawPick[], query: HotelQuery, trace: SearchTrace): Hotel[] {
    const hotels: Hotel[] = [];

    for (const pick of picks) {
      const name = text(pick.name);
      const sourceUrl = text(pick.source_url);
      if (!name || !sourceUrl) {
        trace.droppedUntrusted += 1;
        continue;
      }

      // 링크가 없으면 카드 줄을 만들 수 없다. 지어낸 호스트도 여기서 걸린다.
      if (!isAllowedSourceUrl(sourceUrl)) {
        trace.droppedUntrusted += 1;
        this.logger.warn(`dropped hotel with untrusted url name=${name} url=${sourceUrl}`);
        continue;
      }

      hotels.push({
        name,
        citySlug: query.citySlug,
        // 한국어 페이지로 돌린다. 프롬프트가 안 먹었을 때의 마지막 방어선.
        sourceUrl: toKoreanUrl(sourceUrl),
        merchant: text(pick.merchant) ?? merchantOf(sourceUrl),
        source: 'ai',
        sourceRef: null,
        address: text(pick.address),
        starRating: bounded(pick.star_rating, 1, 5),
        reviewScore: bounded(pick.review_score, 0, 10),
        priceFrom: positiveInt(pick.price_from),
        currency: 'KRW',
        thumbnailUrl: text(pick.thumbnail_url),
        description: text(pick.description),
        tags: Array.isArray(pick.tags)
          ? pick.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          : [],
      });
    }

    return hotels.slice(0, query.limit);
  }

  /**
   * 카드에 넣을 이미지를 확정한다.
   *
   * 모델이 준 주소가 있으면 살아 있는지 확인하고, 없거나 죽었으면
   * **예약 페이지에서 직접 긁는다**([thumbnail.ts](../thumbnail.ts)).
   *
   * ⚠️ 모델은 이미지 주소를 사실상 못 준다 — 1차 후보 스키마에 이미지 필드가 없고,
   *    `web_search` 도 텍스트만 주기 때문이다. 그래서 실질적인 경로는 페이지 긁기다.
   *
   * 콜백 경로에서만 도는 코드라 5초 예산과 무관하다. 결과는 검색 캐시에 같이
   * 저장되므로, 같은 도시를 다시 물어도 페이지를 또 읽지 않는다.
   */
  private async withThumbnails(hotels: Hotel[], trace: SearchTrace): Promise<Hotel[]> {
    if (!this.config.hotelThumbnails) return hotels;

    const resolved = hotels.map(async (hotel) => {
      // ① 모델이 준 주소 (거의 없다)
      if (hotel.thumbnailUrl) {
        if (await isLiveImage(hotel.thumbnailUrl)) {
          trace.thumbnails += 1;
          count(trace.thumbnailSources, 'model');
          return hotel;
        }
        trace.droppedThumbnails += 1;
        this.logger.log(`dropped dead thumbnail hotel=${hotel.name} url=${hotel.thumbnailUrl}`);
      }

      // ② 예약 페이지에서 긁는다
      const found = await this.thumbnailFromPage(hotel.sourceUrl);
      if (!found) return { ...hotel, thumbnailUrl: null };

      if (!(await isLiveImage(found.url))) {
        trace.droppedThumbnails += 1;
        this.logger.log(`page thumbnail not live hotel=${hotel.name} url=${found.url}`);
        return { ...hotel, thumbnailUrl: null };
      }

      trace.thumbnails += 1;
      count(trace.thumbnailSources, found.source);
      this.logger.log(`thumbnail ${found.source} hotel=${hotel.name} url=${found.url}`);
      return { ...hotel, thumbnailUrl: found.url };
    });

    return Promise.all(resolved);
  }

  /** 예약 페이지 HTML 을 (앞부분만) 읽어 대표 이미지를 뽑는다. 실패는 null. */
  private async thumbnailFromPage(
    pageUrl: string,
  ): Promise<{ url: string; source: ThumbnailSource } | null> {
    if (!pageUrl) return null;
    const html = await fetchHtml(
      pageUrl,
      this.config.hotelThumbnailTimeoutMs,
      this.config.hotelThumbnailMaxBytes,
    );
    if (!html) {
      this.logger.log(`thumbnail page unreadable url=${pageUrl}`);
      return null;
    }
    return extractThumbnail(html, pageUrl);
  }
}

/** Record 카운터 증가. 층별 성공률을 보려고 쓴다. */
function count(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/**
 * 예약 페이지를 브라우저인 척 읽는다.
 *
 * ⚠️ **UA 를 안 보내면 403·429 를 준다.** 실제로 hotels.com 이 그렇다.
 *    우리가 이미 사용자에게 링크로 보내주는 공개 페이지이고, 읽는 것은 앞부분 몇백 KB 뿐이다.
 *
 * 본문 전체를 받지 않는 이유: 예약 페이지는 200~400KB 인데 이미지 주소는 앞쪽에 있다.
 * 5곳을 동시에 읽으므로 다 받으면 메모리와 시간을 헛되이 쓴다.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchHtml(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } finally {
      // 다 안 읽고 끊는다. 취소하지 않으면 연결이 남는다.
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 헬퍼
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '정보 없음' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/** 범위를 벗어난 값은 버린다. 모델이 5점 만점 평점을 10점 칸에 넣기도 한다. */
function bounded(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function merchantOf(url: string): string | null {
  return merchantFrom(url, ALLOWED_HOSTS);
}

/**
 * 주소가 실제로 살아 있는 이미지인지 본다. 2초 안에 답 없으면 버린다.
 *
 * CDN 마다 사정이 다르다. 실측하면서 걸린 것들:
 *   - trip.com CDN 은 HEAD 에 **content-type 을 안 준다.** 없다고 버리면 다 놓친다.
 *   - HEAD 자체를 막는 CDN 이 있다. 그때는 1KB 만 받아서 다시 본다.
 */
async function isLiveImage(url: string): Promise<boolean> {
  const acceptable = (res: Response): boolean => {
    if (!res.ok) return false;
    const type = res.headers.get('content-type');
    // 타입을 안 알려주면 200 을 믿는다. 어차피 죽은 주소면 200 이 안 온다.
    return !type || type.startsWith('image/');
  };

  const head = await probe(url, 'HEAD');
  if (head) return acceptable(head);

  const ranged = await probe(url, 'GET', { range: 'bytes=0-1023' });
  return ranged ? acceptable(ranged) : false;
}

async function probe(
  url: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { method, headers, signal: controller.signal });
    // 요청 자체는 성공했으므로 판정은 호출부에 맡긴다.
    await res.body?.cancel().catch(() => undefined);
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

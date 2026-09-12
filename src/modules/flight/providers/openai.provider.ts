import { Inject, Injectable, Logger } from '@nestjs/common';

import { allowedHost, merchantFrom, toKoreanUrl } from '../../../common/booking-url';
import { AppConfig, CONFIG } from '../../../config/app.config';
import { OpenAiService, parseJsonLoose } from '../../openai/openai.service';
import { Flight, FlightProvider, FlightQuery, isoDate } from '../flight.types';

/**
 * gpt-5-mini + 웹 검색으로 항공권을 찾는 provider.
 *
 *   1차 호출 : 웹 검색을 돌려 후보 10~20편을 긁는다 (구조화 JSON)
 *   2차 호출 : 후보를 가격·소요시간·경유로 비교해 상위 N개를 JSON 으로 뽑는다
 *
 * 호텔 provider 와 같은 2단 구조다. 이유도 같다 — 한 번에 시키면 모델이 검색 결과를
 * 요약하는 데 힘을 쓰고 비교/선별은 대충 한다.
 *
 * ⚠️ **항공 운임은 실시간이고 우리는 실시간 API 가 없다.**
 *    웹 검색으로 얻는 건 "그 노선이 대략 얼마인가" 이지 지금 살 수 있는 가격이 아니다.
 *    그래서 카드에 '예상가' 로 적고, 실제 금액은 예약 페이지에서 확인하게 만든다.
 *    여기를 정확한 운임처럼 포장하면 사용자는 카드 가격을 믿고 눌렀다가 배신당한다.
 *    (GDS/항공사 API 가 붙으면 이 provider 를 갈아끼우면 된다 — 그래서 토큰으로 주입한다)
 *
 * ⚠️ 느리다(합쳐서 7~30초). 카카오 5초 예산 안에서 부르면 안 된다.
 *    FlightService 가 콜백/백그라운드에서만 호출한다.
 */

/**
 * 예약 링크로 인정하는 호스트.
 *
 * 호텔은 네 곳을 쓰는데 여기는 두 곳이다 — 클룩·호텔스닷컴은 항공권을 팔지 않아서
 * 허용해두면 모델이 "항공권 링크" 라며 엉뚱한 페이지를 가져온다. 반대로 두 곳은
 * 호텔 쪽에서 이미 애드픽 변환이 되는 게 확인된 곳이라 수익화 경로가 검증돼 있다.
 *
 * ⚠️ 여기를 바꾸면 SEARCH_INSTRUCTIONS 와 스키마의 안내 문구도 같이 바꿔야 한다.
 *    모델에게 A 를 찾으라고 시켜놓고 B 만 통과시키면 결과가 전부 버려진다.
 */
export const FLIGHT_ALLOWED_HOSTS = [
  'trip.com', // 트립닷컴 항공
  'myrealtrip.com', // 마이리얼트립 항공
];

/** 프롬프트에 그대로 박아 넣는 표기. 목록과 문구가 어긋나지 않게 여기서 만든다. */
export const FLIGHT_ALLOWED_SITES_TEXT =
  '트립닷컴(trip.com), 마이리얼트립(myrealtrip.com)';

export function isAllowedFlightUrl(url: string): boolean {
  return allowedHost(url, FLIGHT_ALLOWED_HOSTS);
}

export function flightMerchantOf(url: string): string | null {
  return merchantFrom(url, FLIGHT_ALLOWED_HOSTS);
}

const SEARCH_INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 항공권 리서치 어시스턴트다.',
  '반드시 web_search 툴로 실제 웹을 검색해서 답한다. 기억에 의존하지 않는다.',
  `예약 링크는 반드시 다음 두 곳 중 하나여야 한다: ${FLIGHT_ALLOWED_SITES_TEXT}.`,
  '이 두 곳이 아닌 사이트(스카이스캐너·네이버항공권·항공사 자체 사이트 등)의 링크는 적지 마라.',
  '**반드시 한국어 페이지 주소를 골라라** (www.trip.com 이 아니라 kr.trip.com).',
  '검색 결과에 나오지 않은 편명·시각·가격은 절대 지어내지 않는다. 모르면 null 로 둔다.',
  '항공사는 한국어로 적는다 (Korean Air → 대한항공, Peach → 피치항공).',
  '가격은 1인 기준 총액(세금·유류할증료 포함)을 원화로 적는다.',
  // ⚠️ 이 문단을 지우지 마라. 없으면 모델이 "검색을 진행해도 될까요?" 라고 되묻고 끝난다.
  //    상대는 사람이 아니라 프로그램이라 그 질문에 답해줄 사람이 없다.
  '**절대 되묻지 마라.** 확인을 구하거나 진행 여부를 묻지 말고 즉시 검색해서 결과만 낸다.',
  '날짜가 주어지지 않았으면 특정 날짜를 묻지 말고 최근 기준 일반적인 요금대를 조사한다.',
  '인사말·서론·맺음말·계획 설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

/**
 * 1차 호출도 구조화 출력을 건다.
 *
 * 자유 텍스트로 두면 모델이 "이렇게 정리해 드리겠습니다. 진행할까요?" 같은 문장을
 * 내놓고 끝난다 — 호텔 쪽에서 실제로 그래서 후보가 0개가 된 적 있다.
 */
export const FLIGHT_CANDIDATE_SCHEMA = {
  type: 'json_schema' as const,
  name: 'flight_candidates',
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
          required: ['airline', 'flight_no', 'url', 'price_from', 'stops', 'note'],
          properties: {
            airline: { type: 'string', description: '항공사 (한국어)' },
            flight_no: { type: ['string', 'null'], description: 'KE723 형식. 모르면 null' },
            url: {
              type: 'string',
              description:
                `검색 결과에 실제로 나온 예약 페이지 URL. ${FLIGHT_ALLOWED_SITES_TEXT} 중 하나. ` +
                '반드시 한국어 페이지 (kr.trip.com 등)',
            },
            price_from: {
              type: ['integer', 'null'],
              description: '1인 총액(원). 확인된 값만',
            },
            stops: { type: ['integer', 'null'], description: '경유 횟수. 직항은 0' },
            note: { type: ['string', 'null'], description: '시각·특징 한 줄' },
          },
        },
      },
    },
  },
};

/** 2차 호출에 거는 구조화 출력 스키마. strict 라 모든 키가 required 여야 한다. */
export const FLIGHT_SCHEMA = {
  type: 'json_schema' as const,
  name: 'flight_picks',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['flights'],
    properties: {
      flights: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'airline',
            'flight_no',
            'origin_code',
            'destination_code',
            'depart_date',
            'depart_time',
            'arrive_time',
            'return_date',
            'return_depart_time',
            'return_arrive_time',
            'duration_minutes',
            'stops',
            'via',
            'cabin',
            'price_from',
            'source_url',
            'merchant',
            'tags',
          ],
          properties: {
            airline: { type: 'string', description: '항공사 (한국어)' },
            flight_no: { type: ['string', 'null'], description: 'KE723 형식' },
            origin_code: { type: 'string', description: '출발 공항 IATA 3자' },
            destination_code: { type: 'string', description: '도착 공항 IATA 3자' },
            depart_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
            depart_time: { type: ['string', 'null'], description: '현지 출발 시각 HH:MM' },
            arrive_time: { type: ['string', 'null'], description: '현지 도착 시각 HH:MM' },
            return_date: { type: ['string', 'null'], description: '왕복일 때만. YYYY-MM-DD' },
            return_depart_time: { type: ['string', 'null'], description: 'HH:MM' },
            return_arrive_time: { type: ['string', 'null'], description: 'HH:MM' },
            duration_minutes: {
              type: ['integer', 'null'],
              description: '편도 총 소요 시간(분)',
            },
            stops: { type: ['integer', 'null'], description: '경유 횟수. 직항은 0' },
            via: { type: ['string', 'null'], description: '경유지. 직항이면 null' },
            cabin: {
              type: ['string', 'null'],
              enum: ['economy', 'premium', 'business', 'first', null],
            },
            price_from: {
              type: ['integer', 'null'],
              description: '1인 총액(원). 검색 결과에서 확인한 값만. 모르면 null',
            },
            source_url: {
              type: 'string',
              description:
                `예약 페이지 URL. ${FLIGHT_ALLOWED_SITES_TEXT} 중 하나여야 한다. 한국어 페이지`,
            },
            merchant: { type: ['string', 'null'], description: 'trip | myrealtrip' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '특징 키워드 (최저가, 직항, 오전출발 등)',
            },
          },
        },
      },
    },
  },
};

const RANK_INSTRUCTIONS = [
  '너는 항공권 후보를 비교해 추천 목록을 만드는 어시스턴트다.',
  '주어진 후보 목록 안에서만 고른다. 목록에 없는 항공편을 새로 만들지 않는다.',
  '후보에 적히지 않은 편명·시각·가격은 null 로 둔다. 추측해서 채우지 않는다.',
  '후보의 URL 을 그대로 옮긴다. 임의로 도메인이나 경로를 바꾸지 않는다.',
  '가격만 보지 말고 직항 여부와 출발 시각을 섞어서 고른다.',
  '**요청한 개수를 반드시 채워라.** 후보가 그만큼 없으면 있는 것을 전부 낸다 — 임의로 줄이지 마라.',
].join(' ');

/**
 * 검색 한 번에 대한 계측.
 *
 * 응답 경로에서는 아무도 안 본다 — 진단용 엔드포인트(/api/v1/debug/flight-search)가
 * "어디서 몇 초가 녹았는지"를 보여주려고 모은다. 로그에도 같은 값이 찍힌다.
 */
export interface FlightSearchTrace {
  searchMs: number;
  rankMs: number;
  totalMs: number;
  /** 모델이 web_search 를 실제로 돌린 횟수. 0 이면 기억으로 답한 것이다. */
  searchCalls: number;
  candidateChars: number;
  candidates: number;
  picks: number;
  droppedUntrusted: number;
  flights: number;
}

export interface TracedFlightSearch {
  flights: Flight[];
  trace: FlightSearchTrace;
  /** 1차 호출의 원문. 모델이 뭘 긁어왔는지 눈으로 봐야 할 때가 있다. */
  candidates: string | null;
}

interface RawPick {
  airline?: unknown;
  flight_no?: unknown;
  origin_code?: unknown;
  destination_code?: unknown;
  depart_date?: unknown;
  depart_time?: unknown;
  arrive_time?: unknown;
  return_date?: unknown;
  return_depart_time?: unknown;
  return_arrive_time?: unknown;
  duration_minutes?: unknown;
  stops?: unknown;
  via?: unknown;
  cabin?: unknown;
  price_from?: unknown;
  source_url?: unknown;
  merchant?: unknown;
  tags?: unknown;
}

@Injectable()
export class OpenAiFlightProvider implements FlightProvider {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiFlightProvider.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
  ) {}

  /** 키가 없으면 검색을 시도조차 하지 않는다. 호출부가 미리 알아야 한다. */
  get enabled(): boolean {
    return this.openai.enabled;
  }

  async search(query: FlightQuery): Promise<Flight[]> {
    return (await this.searchTraced(query)).flights;
  }

  /** search() 와 같은 흐름이되 단계별 소요 시간을 같이 돌려준다. */
  async searchTraced(query: FlightQuery): Promise<TracedFlightSearch> {
    const started = Date.now();
    const trace: FlightSearchTrace = {
      searchMs: 0,
      rankMs: 0,
      totalMs: 0,
      searchCalls: 0,
      candidateChars: 0,
      candidates: 0,
      picks: 0,
      droppedUntrusted: 0,
      flights: 0,
    };
    const done = (flights: Flight[], candidates: string | null): TracedFlightSearch => {
      trace.flights = flights.length;
      trace.totalMs = Date.now() - started;
      return { flights, trace, candidates };
    };

    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 항공권 검색을 건너뛴다');
      return done([], null);
    }

    const candidates = await this.findCandidates(query, trace);
    if (!candidates) return done([], null);

    const picks = await this.rank(query, candidates, trace);
    trace.picks = picks.length;

    return done(this.toFlights(picks, query, trace), candidates);
  }

  // -------------------------------------------------- 1차: 웹 검색으로 후보 수집
  private async findCandidates(
    query: FlightQuery,
    trace: FlightSearchTrace,
  ): Promise<string | null> {
    const wanted = this.config.openaiCandidateCount;

    const result = await this.openai.respond({
      instructions: SEARCH_INSTRUCTIONS,
      tools: [this.openai.webSearchToolSpec],
      // ⚠️ 검색을 **반드시** 돌린다. auto 로 두면 모델이 건너뛰고 빈 결과를 낸다.
      toolChoice: 'required',
      effort: this.config.openaiSearchEffort,
      format: FLIGHT_CANDIDATE_SCHEMA,
      input: [
        `${routeText(query)} 항공권 ${wanted}편을 지금 웹에서 검색해 찾아라.`,
        conditionsText(query),
        '항공사와 가격대가 겹치지 않게 다양하게 모아라. 직항과 경유를 섞어라.',
        '확인 못 한 항목은 null 로 둔다. 되묻지 말고 바로 결과를 낸다.',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    trace.searchMs = result.ms;
    trace.searchCalls = result.searchCalls;
    trace.candidateChars = result.text.length;

    // 검색을 한 번도 안 돌았으면 모델이 기억으로 답한 것이다. 운임이 특히 위험하다.
    if (!result.searchCalls) {
      this.logger.warn(`web_search 가 호출되지 않았다 route=${routeText(query)}`);
    }

    const parsed = parseJsonLoose<{ candidates?: unknown[] }>(result.text);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    trace.candidates = candidates.length;

    this.logger.log(
      `flight search ${routeText(query)} searches=${result.searchCalls} ` +
        `candidates=${candidates.length} chars=${result.text.length} ms=${result.ms}`,
    );

    if (!candidates.length) {
      // 스키마를 걸어뒀는데도 비어 오면 프롬프트가 안 먹은 것이다. 원문을 남긴다.
      this.logger.warn(
        `flight search produced no candidates route=${routeText(query)} ` +
          `text=${result.text.slice(0, 200)}`,
      );
      return null;
    }
    return JSON.stringify(candidates);
  }

  // ------------------------------------------------ 2차: 비교 후 상위 N개 선정
  private async rank(
    query: FlightQuery,
    candidates: string,
    trace: FlightSearchTrace,
  ): Promise<RawPick[]> {
    const result = await this.openai.respond({
      instructions: RANK_INSTRUCTIONS,
      effort: this.config.openaiRankEffort,
      format: FLIGHT_SCHEMA,
      input: [
        `다음은 ${routeText(query)} 항공권 후보 목록(JSON)이다.`,
        conditionsText(query),
        `가격·소요시간·경유·출발시각을 비교해 가장 추천할 만한 ${query.limit}편을 골라라.`,
        `예약 페이지 URL 이 없거나 ${FLIGHT_ALLOWED_SITES_TEXT} 밖의 링크인 후보는 제외한다.`,
        `출발 공항은 ${query.originCode ?? query.originName}, 도착 공항은 ${
          query.destCode ?? query.destName
        } 기준으로 채운다.`,
        '',
        '--- 후보 목록 (JSON) ---',
        candidates,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    trace.rankMs = result.ms;

    const parsed = parseJsonLoose<{ flights?: RawPick[] }>(result.text);
    if (!parsed?.flights?.length) {
      this.logger.warn(
        `flight rank produced no picks route=${routeText(query)} status=${result.status} ` +
          `text=${result.text.slice(0, 200)}`,
      );
      return [];
    }

    this.logger.log(
      `flight rank ${routeText(query)} picks=${parsed.flights.length} ms=${result.ms}`,
    );
    return parsed.flights;
  }

  // ------------------------------------------------------------ 정규화
  private toFlights(picks: RawPick[], query: FlightQuery, trace: FlightSearchTrace): Flight[] {
    const flights: Flight[] = [];

    for (const pick of picks) {
      const airline = text(pick.airline);
      const sourceUrl = text(pick.source_url);
      if (!airline || !sourceUrl) {
        trace.droppedUntrusted += 1;
        continue;
      }

      // 링크가 없으면 카드를 만들 수 없다. 지어낸 호스트도 여기서 걸린다.
      if (!isAllowedFlightUrl(sourceUrl)) {
        trace.droppedUntrusted += 1;
        this.logger.warn(`dropped flight with untrusted url airline=${airline} url=${sourceUrl}`);
        continue;
      }

      // 공항 코드는 카드 제목과 dedupe 키에 쓰인다. 모델이 안 주면 쿼리 값으로 채운다
      // (검색 자체가 그 노선으로 나갔으므로 쿼리가 더 믿을 만하다).
      const originCode = code(pick.origin_code) ?? query.originCode ?? query.originSlug.toUpperCase();
      const destCode = code(pick.destination_code) ?? query.destCode ?? query.destSlug.toUpperCase();

      const returnDate = isoDate(pick.return_date);
      flights.push({
        airline,
        flightNo: flightNumber(pick.flight_no),
        originCode,
        originName: query.originName,
        destCode,
        destName: query.destName,
        departDate: isoDate(pick.depart_date),
        departTime: hhmm(pick.depart_time),
        arriveTime: hhmm(pick.arrive_time),
        returnDate: query.tripType === 'round' ? returnDate : null,
        returnDepartTime: query.tripType === 'round' ? hhmm(pick.return_depart_time) : null,
        returnArriveTime: query.tripType === 'round' ? hhmm(pick.return_arrive_time) : null,
        durationMinutes: positiveInt(pick.duration_minutes),
        stops: stops(pick.stops),
        via: text(pick.via),
        tripType: query.tripType,
        cabin: text(pick.cabin),
        priceFrom: positiveInt(pick.price_from),
        currency: 'KRW',
        // 한국어 페이지로 돌린다. 프롬프트가 안 먹었을 때의 마지막 방어선.
        sourceUrl: toKoreanUrl(sourceUrl),
        merchant: text(pick.merchant) ?? flightMerchantOf(sourceUrl),
        source: 'ai',
        tags: Array.isArray(pick.tags)
          ? pick.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          : [],
      });
    }

    return flights.slice(0, query.limit);
  }
}

// ------------------------------------------------------------------ 프롬프트 조각
/** '인천(ICN) → 오사카(KIX)'. 프롬프트와 로그에서 같은 표기를 쓴다. */
export function routeText(query: FlightQuery): string {
  const from = query.originCode ? `${query.originName}(${query.originCode})` : query.originName;
  const to = query.destCode ? `${query.destName}(${query.destCode})` : query.destName;
  return `${from} → ${to}`;
}

/**
 * 검색 조건을 문장으로.
 *
 * ⚠️ **날짜가 없다.** 캐시를 노선·왕복여부로만 가르기로 했기 때문이다
 *    ([search.service.ts](../../search/search.service.ts) cacheKeyOf). 날짜를 안 주면
 *    모델은 되묻거나 임의의 날짜를 지어내므로, **"일반적인 요금대를 조사하라"** 고
 *    명시적으로 못 박는다. 카드에는 "AI 가 정리한 참고 정보" 안내가 항상 붙는다.
 */
export function conditionsText(query: FlightQuery): string {
  return [
    query.tripType === 'round' ? '왕복이다.' : '편도다.',
    '특정 날짜가 정해지지 않았으니 최근 한 달 기준의 일반적인 요금대를 조사한다.',
    '날짜를 지어내지 말고, 확인된 날짜가 없으면 날짜 필드는 null 로 둔다.',
  ].join(' ');
}

// ------------------------------------------------------------------ 헬퍼
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '정보 없음' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/** IATA 공항 코드는 영문 3자다. */
function code(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /[A-Za-z]{3}/.exec(raw);
  return match ? match[0].toUpperCase() : null;
}

/** 'ke 723' → 'KE723'. 편명은 dedupe 키라 표기를 통일해야 한다. */
function flightNumber(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /([A-Za-z]{2})\s*-?\s*(\d{1,4})/.exec(raw);
  return match ? `${match[1].toUpperCase()}${match[2]}` : raw.toUpperCase();
}

/**
 * 'HH:MM' 만 통과시킨다.
 *
 * 모델은 '09:20 (현지)', '오전 9시 20분', '9:20 AM' 을 섞어서 준다. 그대로 카드에
 * 넣으면 20자 줄이 터지고 편끼리 비교도 안 된다. 읽어낼 수 있으면 정규화하고,
 * 못 하면 버린다 — 시각 없는 카드가 틀린 시각보다 낫다.
 */
export function hhmm(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;

  const ampm = /(오전|오후|AM|PM|am|pm)/.exec(raw)?.[1];
  const match = /(\d{1,2})\s*[:시]\s*(\d{1,2})?/.exec(raw);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;

  if (ampm && /오후|PM|pm/.test(ampm) && hour < 12) hour += 12;
  if (ampm && /오전|AM|am/.test(ampm) && hour === 12) hour = 0;
  if (hour > 23) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 경유 횟수. 0 은 유효한 값이므로 positiveInt 로 걸러선 안 된다. */
function stops(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

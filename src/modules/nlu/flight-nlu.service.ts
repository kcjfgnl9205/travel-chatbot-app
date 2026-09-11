import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';
import { citySlugOf, utteranceKeyOf } from './nlu';

/**
 * 항공권 발화 파싱.
 *
 * "다음달 3일에 인천에서 오사카 가는 비행기 2명" → { ICN→KIX, 2026-10-03, 2명, 편도 }
 * "오사카 왕복 항공권 얼마야"                    → { 서울→오사카, 날짜 없음, 왕복 }
 *
 * 호텔 파서([nlu.service.ts](./nlu.service.ts))와 왜 갈라놨나 —
 * 항공권은 뽑아야 하는 게 다르다. 도시 하나가 아니라 **출발지와 도착지 두 개**이고,
 * 날짜가 결과를 완전히 바꾸며("10월 3일" 과 "10월 4일" 은 다른 검색이다),
 * 편도/왕복이라는 축이 하나 더 붙는다. 한 스키마에 다 넣으면 호텔 파싱이 항공권
 * 필드를 매번 null 로 채우게 되고, 그건 5초 예산 안에서 도는 호출에 붙는 순수한 낭비다.
 *
 * ⚠️ **이건 카카오 5초 예산 안에서 돈다.** 호텔 파서와 같은 두 규칙을 지킨다.
 *   1. 같은 문장은 두 번 부르지 않는다 (별칭 캐시)
 *   2. 짧게 끊는다 (OPENAI_PARSE_TIMEOUT_SECONDS). 늦으면 포기하고 되묻는다
 *
 * ⚠️ **캐시 키에 오늘 날짜가 들어간다.** "내일 오사카" 를 어제 파싱해둔 값으로
 *    답하면 하루 지난 날짜로 검색하게 된다. 날짜가 섞인 발화는 어제의 답이 오늘의
 *    답이 아니다.
 */

const INSTRUCTIONS = [
  '너는 한국어 여행 챗봇의 항공권 발화 파서다.',
  '사용자 발화에서 출발지·도착지·날짜·인원·좌석등급을 뽑아 JSON 으로만 답한다.',
  '도시명 오타는 교정하고 표준 한국어 표기로 통일한다 ("동경"→도쿄, "오오사카"→오사카).',
  '공항 코드(IATA 3자)를 아는 도시는 대표 공항 코드를 함께 채운다 (서울→ICN, 오사카→KIX).',
  '**상대 날짜는 반드시 절대 날짜(YYYY-MM-DD)로 바꾼다.** 오늘 날짜는 입력으로 준다.',
  '"이번 주말"은 다가오는 토요일, "다음주"는 다음 월요일을 기준으로 잡는다.',
  '돌아오는 날짜가 언급되면 왕복(round), 아니면 편도(oneway)로 본다.',
  '"왕복"이라고만 하고 날짜가 없으면 trip_type 은 round, return_date 는 null 이다.',
  '출발지를 말하지 않았으면 origin 을 null 로 둔다. 서울이라고 추측하지 마라.',
  '도착지가 없거나 인사말·잡담이면 destination 관련 값을 모두 null 로 둔다.',
  '나라 이름만 있으면(예: "일본 항공권") 도시가 아니므로 null 이다.',
].join(' ');

const SCHEMA = {
  type: 'json_schema' as const,
  name: 'parsed_flight_utterance',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'origin_name',
      'origin_slug',
      'origin_code',
      'destination_name',
      'destination_slug',
      'destination_code',
      'depart_date',
      'return_date',
      'trip_type',
      'passengers',
      'cabin',
    ],
    properties: {
      origin_name: {
        type: ['string', 'null'],
        description: '출발 도시의 표준 한국어명. 말하지 않았으면 null',
      },
      origin_slug: {
        type: ['string', 'null'],
        description: '영문 소문자 슬러그. seoul, busan 처럼. 없으면 null',
      },
      origin_code: {
        type: ['string', 'null'],
        description: '출발 공항 IATA 코드 3자(ICN, GMP, PUS). 모르면 null',
      },
      destination_name: {
        type: ['string', 'null'],
        description: '도착 도시의 표준 한국어명. 오타 교정 후. 없으면 null',
      },
      destination_slug: {
        type: ['string', 'null'],
        description: '영문 소문자 슬러그. osaka, danang 처럼. 없으면 null',
      },
      destination_code: {
        type: ['string', 'null'],
        description: '도착 공항 IATA 코드 3자(KIX, NRT, DAD). 모르면 null',
      },
      depart_date: {
        type: ['string', 'null'],
        description: '가는 날 YYYY-MM-DD. 언급이 없으면 null',
      },
      return_date: {
        type: ['string', 'null'],
        description: '오는 날 YYYY-MM-DD. 편도이거나 언급이 없으면 null',
      },
      trip_type: {
        type: 'string',
        enum: ['oneway', 'round'],
        description: '왕복 단서가 있으면 round, 없으면 oneway',
      },
      passengers: { type: ['integer', 'null'], description: '탑승 인원. 없으면 null' },
      cabin: {
        type: ['string', 'null'],
        enum: ['economy', 'premium', 'business', 'first', null],
        description: '좌석 등급. 언급이 없으면 null',
      },
    },
  },
};

export type TripType = 'oneway' | 'round';

export interface ParsedFlight {
  originName: string | null;
  originSlug: string | null;
  originCode: string | null;
  destName: string | null;
  destSlug: string | null;
  destCode: string | null;
  /** YYYY-MM-DD. 모르면 null — provider 가 "일반적인 요금대"를 조사한다. */
  departDate: string | null;
  returnDate: string | null;
  tripType: TripType;
  passengers: number | null;
  cabin: string | null;
}

export const EMPTY_FLIGHT: ParsedFlight = {
  originName: null,
  originSlug: null,
  originCode: null,
  destName: null,
  destSlug: null,
  destCode: null,
  departDate: null,
  returnDate: null,
  tripType: 'oneway',
  passengers: null,
  cabin: null,
};

/** 검색을 시작할 수 있는가. 도착지 하나만 있으면 된다 (출발지는 기본값으로 채운다). */
export const hasRoute = (p: ParsedFlight): boolean => p.destSlug !== null;

/** resolve() 와 같지만 실패 원인까지 돌려준다. 진단 엔드포인트가 쓴다. */
export interface FlightParseOutcome {
  parsed: ParsedFlight;
  /** entity: 오픈빌더가 준 값 · cache: 별칭 캐시 · model: 모델 호출 · skipped: 시도 안 함 */
  source: 'entity' | 'cache' | 'model' | 'skipped';
  error: string | null;
  timedOut: boolean;
  ms: number;
}

interface RawParse {
  origin_name?: unknown;
  origin_slug?: unknown;
  origin_code?: unknown;
  destination_name?: unknown;
  destination_slug?: unknown;
  destination_code?: unknown;
  depart_date?: unknown;
  return_date?: unknown;
  trip_type?: unknown;
  passengers?: unknown;
  cabin?: unknown;
}

interface CacheEntry {
  parsed: ParsedFlight;
  expiresAt: number;
}

/** 별칭 캐시 상한. 문장 하나당 한 칸이라 넉넉히 잡아도 가볍다. */
const MAX_ENTRIES = 5000;

/** 오픈빌더 엔티티로 넘어올 수 있는 파라미터 이름들. */
export const ORIGIN_PARAMS = ['origin', 'departure', 'from_city'];
export const DEST_PARAMS = ['destination', 'arrival', 'to_city', 'city', 'sys_location'];
export const DEPART_PARAMS = ['depart_date', 'date', 'sys_date'];
export const RETURN_PARAMS = ['return_date'];

@Injectable()
export class FlightNluService {
  private readonly logger = new Logger(FlightNluService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
  ) {}

  /** 캐시만 본다. 모델을 부르지 않으므로 공짜다. 폴백 블록처럼 돈 쓸 필요 없는 곳에서 쓴다. */
  peek(utterance: string): ParsedFlight {
    const key = this.keyOf(utterance);
    const hit = this.cache.get(key);
    if (!hit) return EMPTY_FLIGHT;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return EMPTY_FLIGHT;
    }
    return hit.parsed;
  }

  async resolve(
    utterance: string,
    hints: FlightHints = {},
    opts: { fresh?: boolean } = {},
  ): Promise<ParsedFlight> {
    return (await this.resolveDetailed(utterance, hints, opts)).parsed;
  }

  async resolveDetailed(
    utterance: string,
    hints: FlightHints = {},
    opts: { fresh?: boolean } = {},
  ): Promise<FlightParseOutcome> {
    const started = Date.now();
    const done = (
      parsed: ParsedFlight,
      source: FlightParseOutcome['source'],
      error: string | null = null,
    ): FlightParseOutcome => ({
      parsed,
      source,
      error,
      timedOut: Boolean(error && /timeout/i.test(error)),
      ms: Date.now() - started,
    });

    // fresh: 캐시를 읽지도 쓰지도 않는다. 진단 엔드포인트가 콜드 경로의 진짜
    // 소요 시간을 재려고 쓴다 — 두 번째 호출이 0ms 로 찍히면 의미가 없다.
    const cached = opts.fresh ? EMPTY_FLIGHT : this.peek(utterance);

    // 오픈빌더가 도착지를 뽑아줬으면 모델을 부를 이유가 없다.
    // 날짜는 엔티티가 있어도 모델을 부른다 — sys_date 는 "다음달 3일" 같은 걸
    // 절대 날짜로 주지 않을 때가 있고, 그러면 검색이 통째로 틀어진다.
    const dest = hints.destination?.trim();
    if (dest) {
      return done(
        {
          ...cached,
          destName: dest,
          destSlug: citySlugOf(dest),
          originName: hints.origin?.trim() || cached.originName,
          originSlug: hints.origin?.trim() ? citySlugOf(hints.origin.trim()) : cached.originSlug,
          departDate: isoDate(hints.departDate) ?? cached.departDate,
          returnDate: isoDate(hints.returnDate) ?? cached.returnDate,
        },
        'entity',
      );
    }

    if (cached.destSlug) return done(cached, 'cache');
    if (!utterance.trim()) return done(EMPTY_FLIGHT, 'skipped');
    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 항공권 발화 파싱을 건너뛴다');
      return done(EMPTY_FLIGHT, 'skipped', 'OPENAI_API_KEY 가 설정되지 않았습니다');
    }

    const { parsed, error } = await this.callModel(utterance);
    // 파싱 실패는 캐싱하지 않는다. 일시적 오류를 하루 동안 굳혀버리면 안 된다.
    if (parsed.destSlug && !opts.fresh) this.remember(this.keyOf(utterance), parsed);
    return done(parsed, 'model', error);
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------- 내부
  private async callModel(
    utterance: string,
  ): Promise<{ parsed: ParsedFlight; error: string | null }> {
    try {
      const result = await this.openai.respond({
        instructions: INSTRUCTIONS,
        // 오늘이 며칠인지 모르면 "내일" 을 절대 날짜로 바꿀 수 없다.
        // 모델의 학습 시점이 아니라 **지금** 서울 날짜를 줘야 한다.
        input: `오늘은 ${todayInSeoul()} 이다.\n발화: ${utterance}`,
        model: this.config.openaiParseModel,
        effort: this.config.openaiParseEffort,
        format: SCHEMA,
        timeoutMs: this.config.openaiParseTimeoutMs,
      });

      const raw = parseJsonLoose<RawParse>(result.text);
      if (!raw) {
        this.logger.warn(`flight nlu unreadable text=${result.text.slice(0, 120)}`);
        return {
          parsed: EMPTY_FLIGHT,
          error: `응답을 JSON 으로 못 읽었다: ${result.text.slice(0, 120)}`,
        };
      }

      const destName = text(raw.destination_name);
      const originName = text(raw.origin_name);
      const returnDate = isoDate(text(raw.return_date));
      const parsed: ParsedFlight = {
        originName,
        originSlug: originName ? citySlugOf(text(raw.origin_slug) ?? originName) : null,
        originCode: airportCode(raw.origin_code),
        destName,
        destSlug: destName ? citySlugOf(text(raw.destination_slug) ?? destName) : null,
        destCode: airportCode(raw.destination_code),
        departDate: isoDate(text(raw.depart_date)),
        returnDate,
        // 오는 날이 있는데 편도라고 왔으면 날짜를 믿는다. 그 반대는 있을 수 있다
        // ("왕복 얼마야" — 날짜 없는 왕복).
        tripType: returnDate || raw.trip_type === 'round' ? 'round' : 'oneway',
        passengers: positiveInt(raw.passengers),
        cabin: text(raw.cabin),
      };

      this.logger.log(
        `flight nlu "${utterance.slice(0, 40)}" → ${parsed.originSlug ?? '-'}→${parsed.destSlug ?? '-'} ` +
          `depart=${parsed.departDate ?? '-'} return=${parsed.returnDate ?? '-'} ` +
          `pax=${parsed.passengers ?? '-'} ms=${result.ms}`,
      );
      return { parsed, error: null };
    } catch (err) {
      // 5초 예산이 걸린 자리다. 못 뽑으면 되묻기로 넘어가는 게 맞다.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`flight nlu failed err=${message}`);
      return { parsed: EMPTY_FLIGHT, error: message };
    }
  }

  /** 캐시 키. 오늘 날짜를 섞어서 "내일" 이 어제의 내일이 되는 걸 막는다. */
  private keyOf(utterance: string): string {
    return `${todayInSeoul()}:${utteranceKeyOf(utterance)}`;
  }

  private remember(key: string, parsed: ParsedFlight): void {
    // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      parsed,
      expiresAt: Date.now() + this.config.nluAliasTtlMinutes * 60_000,
    });
  }
}

/** 오픈빌더 엔티티가 뽑아준 값. 있으면 모델보다 우선한다. */
export interface FlightHints {
  origin?: string | null;
  destination?: string | null;
  departDate?: string | null;
  returnDate?: string | null;
}

/**
 * 서울 기준 오늘 (YYYY-MM-DD).
 *
 * 서버가 UTC 로 떠 있으면 한국 시각 오전 9시 전까지는 어제가 된다.
 * 그 상태로 "내일" 을 시키면 사용자에게는 오늘 표가 검색된다.
 */
export function todayInSeoul(now: Date = new Date()): string {
  // en-CA 로케일이 YYYY-MM-DD 를 준다. 직접 조립하면 자리수 처리를 또 써야 한다.
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/** IATA 코드는 영문 3자다. 모델이 'ICN 인천' 처럼 주면 코드만 남긴다. */
function airportCode(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /[A-Za-z]{3}/.exec(raw);
  return match ? match[0].toUpperCase() : null;
}

/**
 * YYYY-MM-DD 만 통과시킨다.
 *
 * 모델이 "다음달 3일" 을 그대로 돌려주거나 2026-13-45 같은 걸 만들면 캐시 키가
 * 오염되고 검색 프롬프트도 망가진다. **형식과 실재하는 날짜인지 둘 다 본다.**
 */
export function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // 2026-02-30 은 Date 가 3월 2일로 굴려버린다. 되돌려 보고 같은지 확인한다.
  return parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

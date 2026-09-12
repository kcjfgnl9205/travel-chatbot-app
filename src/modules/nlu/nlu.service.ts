import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';
import { findCityInText, lookupCity } from './city-table';
import { EMPTY_QUERY, ParsedQuery, citySlugOf, utteranceKeyOf } from './nlu';

/**
 * 발화 파싱.
 *
 * "오사카 여행갈건데 4명기준으로 숙소 추천해줘" → { osaka, 오사카, guests: 4 }
 * "오사카 호텔"                                → { osaka, 오사카 }  ← 오타 교정
 * "동경 숙소"                                  → { tokyo, 도쿄 }    ← 표기 통일
 *
 * **도시를 찾는 순서가 셋이다.** 위에서 걸리면 아래는 안 본다.
 *
 *   1. **오픈빌더 엔티티** (`여행도시`). 카카오가 이미 도시로 확정한 값이라 가장 정확하고
 *      공짜다. 블록에 엔티티가 붙어 있으면 사실상 여기서 끝난다.
 *   2. **도시 사전** ([city-table.ts](./city-table.ts)). 엔티티가 안 왔을 때의 폴백.
 *      역시 0ms·0원이고, 모델이 2.5초를 넘겨 되묻던 경우를 없애준다.
 *   3. **모델** (gpt-5-mini). 사전에 없는 도시·오타·긴 문장이 여기로 온다.
 *
 * 1·2 로 도시가 정해져도 **발화에 숫자가 섞여 있으면** 인원·박수를 뽑으려고 모델을
 * 한 번 더 부른다 ("오사카 호텔 4명 2박"). 도시는 이미 정해졌으므로 모델이 도시를
 * 틀리게 말해도 무시한다.
 *
 * ⚠️ **이건 카카오 5초 예산 안에서 돈다.** 그래서 두 가지를 지킨다.
 *   1. 같은 문장은 두 번 부르지 않는다 (별칭 캐시). 이게 없으면 매 메시지가 유료다.
 *   2. 짧게 끊는다 (OPENAI_PARSE_TIMEOUT_SECONDS, 기본 2.5초). 늦으면 포기하고
 *      도시 미상으로 넘긴다 — 5초를 넘겨서 카카오에 아무것도 못 주는 것보다 낫다.
 *
 * 검색용 호출(7~30초)과 달리 툴도 안 쓰고 effort 도 minimal 이라 훨씬 싸고 빠르다.
 */

/**
 * 인원·박수 단서. 이게 없으면 도시가 정해진 순간 모델을 부르지 않는다.
 *
 * "세부 여행지 추천해줘" 에 모델을 붙이면 2.5초와 요금을 아무것도 아닌 데 쓴다.
 */
const DETAIL_HINT = /[0-9０-９]|가족|커플|혼자|둘이|셋이|넷이/;

const INSTRUCTIONS = [
  '너는 한국어 여행 챗봇의 발화 파서다.',
  '사용자 발화에서 여행 목적지 도시와 투숙 조건을 뽑아 JSON 으로만 답한다.',
  '도시명 오타는 교정한다 ("오사카"→오사카, "후쿠오까"→후쿠오카).',
  '다른 표기는 표준 한국어 표기로 통일한다 ("동경"→도쿄, "Bangkok"→방콕).',
  '도시가 없거나 인사말·잡담이면 city_name 과 city_slug 를 null 로 둔다.',
  '나라 이름만 있으면(예: "일본 호텔") 도시가 아니므로 null 이다.',
].join(' ');

const SCHEMA = {
  type: 'json_schema' as const,
  name: 'parsed_utterance',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['city_name', 'city_slug', 'guests', 'nights'],
    properties: {
      city_name: {
        type: ['string', 'null'],
        description: '표준 한국어 도시명. 오타 교정 후. 도시가 없으면 null',
      },
      city_slug: {
        type: ['string', 'null'],
        description:
          '영문 소문자 슬러그. osaka, bangkok, new-york 처럼. 없으면 null',
      },
      guests: {
        type: ['integer', 'null'],
        description: '투숙 인원. 없으면 null',
      },
      nights: {
        type: ['integer', 'null'],
        description: '숙박 일수(박). 없으면 null',
      },
    },
  },
};

interface RawParse {
  city_name?: unknown;
  city_slug?: unknown;
  guests?: unknown;
  nights?: unknown;
}

interface CacheEntry {
  parsed: ParsedQuery;
  expiresAt: number;
}

/**
 * 파싱 결과 + **왜 그렇게 됐는지**.
 *
 * 스킬 경로는 parsed 만 있으면 되지만, 진단 엔드포인트는 "도시를 못 뽑았다"와
 * "타임아웃이라 물어보지도 못했다"를 구분해야 한다. 그걸 뭉개면
 * 원인을 보여주려고 만든 엔드포인트가 거짓말을 하게 된다.
 */
export interface ParseOutcome {
  parsed: ParsedQuery;
  /**
   * entity: 오픈빌더가 준 값 · table: 도시 사전 · cache: 별칭 캐시 ·
   * model: 모델 호출 · skipped: 시도 안 함
   */
  source: 'entity' | 'table' | 'cache' | 'model' | 'skipped';
  /** 모델 호출이 실패한 이유. 성공했거나 시도 안 했으면 null. */
  error: string | null;
  timedOut: boolean;
  ms: number;
}

export interface ResolveOptions {
  /** 캐시를 읽지도 쓰지도 않는다. 진단 엔드포인트가 콜드 경로를 재려고 쓴다. */
  fresh?: boolean;
  /**
   * 도시만 있으면 된다. 인원·박수를 위한 추가 모델 호출을 건너뛴다.
   *
   * 관광지는 "4명" 을 알아도 쓸 데가 없다 — 호텔만 인원을 검색에 넘긴다.
   */
  cityOnly?: boolean;
}

/** 별칭 캐시 상한. 문장 하나당 한 칸이라 넉넉히 잡아도 가볍다. */
const MAX_ENTRIES = 5000;

@Injectable()
export class NluService {
  private readonly logger = new Logger(NluService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
  ) {}

  /**
   * 공짜로 알 수 있는 것만 본다 — 별칭 캐시와 도시 사전. 모델은 부르지 않는다.
   * 폴백 블록처럼 "굳이 돈 쓸 필요 없는" 경로에서 쓴다.
   */
  peek(utterance: string): ParsedQuery {
    const key = utteranceKeyOf(utterance);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.parsed;
    if (hit) this.cache.delete(key);

    const city = findCityInText(utterance);
    if (!city) return EMPTY_QUERY;
    return { ...EMPTY_QUERY, cityName: city.nameKo, citySlug: city.slug };
  }

  /**
   * 발화를 파싱한다. 엔티티 → 도시 사전 → 별칭 캐시 → 모델 순으로 본다.
   *
   * @param cityParam 오픈빌더가 뽑아준 도시 (여행도시 엔티티). 있으면 그게 정답이다.
   */
  async resolve(
    utterance: string,
    cityParam?: string | null,
    opts: ResolveOptions = {},
  ): Promise<ParsedQuery> {
    return (await this.resolveDetailed(utterance, cityParam, opts)).parsed;
  }

  /** resolve() 와 같지만 실패 원인까지 돌려준다. 진단 엔드포인트가 쓴다. */
  async resolveDetailed(
    utterance: string,
    cityParam?: string | null,
    opts: ResolveOptions = {},
  ): Promise<ParseOutcome> {
    const started = Date.now();
    const done = (
      parsed: ParsedQuery,
      source: ParseOutcome['source'],
      error: string | null = null,
    ): ParseOutcome => ({
      parsed,
      source,
      error,
      timedOut: Boolean(error && /timeout/i.test(error)),
      ms: Date.now() - started,
    });

    // fresh: 캐시를 읽지도 쓰지도 않는다. 진단 엔드포인트가 콜드 경로의
    // 진짜 소요 시간을 재려고 쓴다 — 두 번째 호출이 0ms 로 찍히면 의미가 없다.
    // peek 이 아니라 캐시를 직접 본다 — 사전 조회는 아래에서 따로 하고,
    // 출처(source)를 cache 와 table 로 구분해야 진단이 거짓말을 하지 않는다.
    const cached = opts.fresh ? EMPTY_QUERY : this.cached(utterance);

    // 엔티티가 왔으면 모델에 도시를 다시 물을 이유가 없다 — 이미 도시로 뽑힌 값이다.
    // 사전에 있으면 대표 한국어명으로 통일한다 ("동경" 엔티티 → 도쿄/tokyo).
    const param = cityParam?.trim();
    if (param) {
      const known = lookupCity(param);
      return this.withDetails(
        {
          ...cached,
          cityName: known?.nameKo ?? param,
          citySlug: known?.slug ?? citySlugOf(param),
        },
        utterance,
        'entity',
        opts,
        done,
      );
    }

    if (cached.citySlug) return done(cached, 'cache');

    // 엔티티가 안 왔다 — 모델을 부르기 전에 사전을 본다. 공짜고 즉시 끝난다.
    const fromTable = findCityInText(utterance);
    if (fromTable) {
      return this.withDetails(
        { ...cached, cityName: fromTable.nameKo, citySlug: fromTable.slug },
        utterance,
        'table',
        opts,
        done,
      );
    }

    if (!utterance.trim()) return done(EMPTY_QUERY, 'skipped');
    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 발화 파싱을 건너뛴다');
      return done(
        EMPTY_QUERY,
        'skipped',
        'OPENAI_API_KEY 가 설정되지 않았습니다',
      );
    }

    const { parsed, error } = await this.callModel(utterance);
    // 파싱 실패는 캐싱하지 않는다. 일시적 오류를 하루 동안 굳혀버리면 안 된다.
    if (parsed.citySlug && !opts.fresh)
      this.remember(utteranceKeyOf(utterance), parsed);
    return done(parsed, 'model', error);
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------- 내부
  /** 별칭 캐시만 본다. 사전은 보지 않는다 (peek 과 다른 점). */
  private cached(utterance: string): ParsedQuery {
    const key = utteranceKeyOf(utterance);
    const hit = this.cache.get(key);
    if (!hit) return EMPTY_QUERY;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return EMPTY_QUERY;
    }
    return hit.parsed;
  }

  /**
   * 도시는 이미 정해졌다. 인원·박수만 모델로 마저 채운다.
   *
   * 숫자가 없는 발화("세부 호텔 추천해줘")는 모델을 부르지 않고 그대로 돌려준다.
   * 모델이 도시를 다르게 말해도 무시한다 — 엔티티·사전이 더 믿을 만하다.
   */
  private async withDetails(
    parsed: ParsedQuery,
    utterance: string,
    source: ParseOutcome['source'],
    opts: ResolveOptions,
    done: (
      parsed: ParsedQuery,
      source: ParseOutcome['source'],
      error?: string | null,
    ) => ParseOutcome,
  ): Promise<ParseOutcome> {
    const enough =
      opts.cityOnly ||
      parsed.guests !== null ||
      !DETAIL_HINT.test(utterance) ||
      !this.openai.enabled;
    if (enough) return done(parsed, source);

    const { parsed: detail, error } = await this.callModel(utterance);
    const merged: ParsedQuery = {
      ...parsed,
      guests: detail.guests ?? parsed.guests,
      nights: detail.nights ?? parsed.nights,
    };
    if (!opts.fresh) this.remember(utteranceKeyOf(utterance), merged);
    return done(merged, source, error);
  }

  private async callModel(
    utterance: string,
  ): Promise<{ parsed: ParsedQuery; error: string | null }> {
    try {
      const result = await this.openai.respond({
        instructions: INSTRUCTIONS,
        input: utterance,
        model: this.config.openaiParseModel,
        effort: this.config.openaiParseEffort,
        format: SCHEMA,
        timeoutMs: this.config.openaiParseTimeoutMs,
      });

      const raw = parseJsonLoose<RawParse>(result.text);
      if (!raw) {
        this.logger.warn(
          `nlu parse unreadable text=${result.text.slice(0, 120)}`,
        );
        return {
          parsed: EMPTY_QUERY,
          error: `응답을 JSON 으로 못 읽었다: ${result.text.slice(0, 120)}`,
        };
      }

      const cityName = text(raw.city_name);
      const parsed: ParsedQuery = {
        cityName,
        citySlug: cityName ? citySlugOf(text(raw.city_slug) ?? cityName) : null,
        guests: positiveInt(raw.guests),
        nights: positiveInt(raw.nights),
      };

      this.logger.log(
        `nlu parse "${utterance.slice(0, 40)}" → city=${parsed.citySlug ?? '-'} ` +
          `guests=${parsed.guests ?? '-'} model=${this.config.openaiParseModel} ms=${result.ms}`,
      );
      return { parsed, error: null };
    } catch (err) {
      // 5초 예산이 걸린 자리다. 못 뽑으면 되묻기로 넘어가는 게 맞다.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`nlu parse failed err=${message}`);
      return { parsed: EMPTY_QUERY, error: message };
    }
  }

  private remember(key: string, parsed: ParsedQuery): void {
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

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AppConfig, CONFIG } from '../../config/app.config';
import { IntentCacheRepository } from '../database/repositories/intent-cache.repository';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';
import { findCityInText } from '../places/city-table';
import { SearchKind, TripType } from '../search/search.types';
import {
  ParsedIntent,
  UNKNOWN_INTENT,
  fromCommand,
  ignoredConditions,
  intentFromKeywords,
  mergeIgnored,
  tripTypeOf,
} from './intent.types';

/**
 * 발화 해석. **의도와 지역을 한 번에 뽑는다.**
 *
 *   "@여행메이트 오사카 호텔 4명 9월 22~24일 추천해줘"
 *     → { intent: 'hotel', place: '오사카', ignored: ['4명', '9월 22~24일'] }
 *
 * 블록이 사라졌으므로 "무엇을 묻는지" 부터 서버가 정해야 한다. 순서는 셋이다.
 *
 *   1. **캐시** (메모리 → intent_cache). 단톡방은 같은 말이 반복된다
 *   2. **키워드 + 도시 사전.** 0ms·0원. "오사카 호텔 추천해줘" 는 여기서 끝난다
 *   3. **모델.** 사전에 없는 지명·긴 문장·출발지가 섞인 항공권 질문
 *
 * ⚠️ **이건 카카오 5초 예산 안에서 돈다.** 모델 호출은 짧게 끊고
 *    (OPENAI_PARSE_TIMEOUT_SECONDS), 실패하면 unknown 으로 떨어져 도움말이 나간다.
 *    5초를 넘겨 아무것도 못 주는 것보다 낫다.
 */

const INSTRUCTIONS = [
  '너는 한국어 여행 단톡방 챗봇의 발화 해석기다.',
  '사용자 발화에서 의도·지역·출발지·왕복여부·무시한 조건을 뽑아 JSON 으로만 답한다.',
  'intent 는 hotel(숙소) / flight(항공권) / attraction(관광지·맛집·볼거리) 중 하나다.',
  '세 가지 중 어느 것도 아니면 intent 는 unknown 이다.',
  'place 는 도시가 아니어도 된다 — "도톤보리", "해운대" 처럼 세부 지역도 그대로 적는다.',
  '지명 오타는 교정하고 표준 한국어 표기로 통일한다 ("동경"→도쿄, "오오사카"→오사카).',
  '나라 이름만 있으면(예: "일본 호텔") 지역이 아니므로 place 는 null 이다.',
  'from 은 항공권의 출발지다. 말하지 않았으면 null 로 둔다. 서울이라고 추측하지 마라.',
  '"편도" 의미가 있으면 trip_type 은 ow, 아니면 rt 다.',
  'ignored 에는 날짜·인원·예산처럼 검색에 반영할 수 없는 조건을 사용자가 말한 그대로 담는다.',
].join(' ');

const SCHEMA = {
  type: 'json_schema' as const,
  name: 'parsed_intent',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'place', 'from', 'trip_type', 'ignored'],
    properties: {
      intent: { type: 'string', enum: ['hotel', 'flight', 'attraction', 'unknown'] },
      place: {
        type: ['string', 'null'],
        description: '목적지. 도시·구역·명소 무엇이든 그대로. 없으면 null',
      },
      from: { type: ['string', 'null'], description: '항공권 출발지. 없으면 null' },
      trip_type: { type: 'string', enum: ['rt', 'ow'], description: '기본 rt(왕복)' },
      ignored: {
        type: 'array',
        items: { type: 'string' },
        description: '날짜·인원·예산 등 검색에 반영되지 않는 조건. 사용자가 말한 표현 그대로',
      },
    },
  },
};

interface RawIntent {
  intent?: unknown;
  place?: unknown;
  from?: unknown;
  trip_type?: unknown;
  ignored?: unknown;
}

interface CacheEntry {
  parsed: ParsedIntent;
  expiresAt: number;
}

/** 메모리 캐시 상한. 문장 하나당 한 칸이라 넉넉해도 가볍다. */
const MAX_ENTRIES = 5000;

const KINDS = new Set<string>(['hotel', 'flight', 'attraction']);

@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
    private readonly repo: IntentCacheRepository,
  ) {}

  async extract(utterance: string): Promise<ParsedIntent> {
    const text = utterance.trim();
    if (!text) return UNKNOWN_INTENT;

    const hash = hashOf(text);
    const cached = this.fromMemory(hash) ?? (await this.fromStore(hash));
    if (cached) return cached;

    // 대표 명령어("여행지 오사카")는 의도가 확정이고 뒤가 곧 지명이다. 사전에 없는
    // 지명이어도 모델을 안 부른다 — 대표 명령어를 쓰는 사용자는 늘 0원이 된다.
    const command = fromCommand(text);
    if (command) {
      this.logger.log(`intent (command) "${clip(text)}" → ${command.intent}/${command.place}`);
      return this.remember(hash, command);
    }

    const fast = fromKeywords(text);
    if (fast) {
      this.logger.log(`intent (keyword) "${clip(text)}" → ${fast.intent}/${fast.place}`);
      return this.remember(hash, fast);
    }

    const parsed = await this.askModel(text);
    // unknown 은 캐싱하지 않는다. 모델이 한 번 헛돈 것을 일주일씩 굳히면
    // 멀쩡한 질문이 그동안 계속 도움말로 떨어진다.
    if (parsed.intent === 'unknown') return this.degrade(text);
    return this.remember(hash, parsed);
  }

  /** 테스트·운영 점검용. 메모리 단만 비운다. */
  clearMemory(): void {
    this.cache.clear();
  }

  /**
   * 모델이 못 뽑았는데 **무엇을 원하는지는 분명한** 경우.
   *
   * "호텔 추천해줘" 나, 모델이 뻗은 채로 들어온 "도톤보리 호텔" 이 여기 온다.
   * 그때 도움말 카드를 주면 "나는 호텔을 물었는데 왜 메뉴를 보여주지?" 가 된다 —
   * 지역만 되물으면 사용자는 한 마디로 답할 수 있다.
   *
   * 캐싱하지 않는다. 다음 번엔 모델이 제대로 뽑을 수 있다.
   */
  private degrade(utterance: string): ParsedIntent {
    const intent = intentFromKeywords(utterance);
    if (intent === 'unknown') return UNKNOWN_INTENT;
    return {
      intent,
      place: null,
      from: null,
      tripType: tripTypeOf(utterance),
      ignored: ignoredConditions(utterance),
    };
  }

  // ---------------------------------------------------------------- 내부
  private fromMemory(hash: string): ParsedIntent | null {
    const hit = this.cache.get(hash);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(hash);
      return null;
    }
    return hit.parsed;
  }

  private async fromStore(hash: string): Promise<ParsedIntent | null> {
    if (!this.repo.enabled) return null;
    try {
      const raw = await this.repo.get(hash);
      if (!raw || typeof raw !== 'object') return null;
      const parsed = normalize(raw as RawIntent, '');
      return parsed.intent === 'unknown' ? null : parsed;
    } catch (err) {
      this.logger.warn(`intent cache read failed err=${err}`);
      return null;
    }
  }

  private remember(hash: string, parsed: ParsedIntent): ParsedIntent {
    if (this.cache.size >= MAX_ENTRIES) {
      // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, {
      parsed,
      expiresAt: Date.now() + this.config.intentCacheTtlMinutes * 60_000,
    });

    if (this.repo.enabled) {
      // 저장 때문에 응답이 늦어질 이유는 없다. 실패하면 다음에 다시 쓴다.
      void this.repo
        .put(hash, toRaw(parsed), this.config.intentCacheTtlMinutes)
        .catch(() => undefined);
    }
    return parsed;
  }

  private async askModel(utterance: string): Promise<ParsedIntent> {
    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 발화 해석을 건너뛴다');
      return UNKNOWN_INTENT;
    }

    try {
      const result = await this.openai.respond({
        instructions: INSTRUCTIONS,
        input: utterance,
        model: this.config.openaiParseModel,
        effort: this.config.openaiParseEffort,
        format: SCHEMA,
        timeoutMs: this.config.openaiParseTimeoutMs,
      });

      const raw = parseJsonLoose<RawIntent>(result.text);
      if (!raw) {
        this.logger.warn(`intent parse unreadable text=${clip(result.text)}`);
        return UNKNOWN_INTENT;
      }

      const parsed = normalize(raw, utterance);
      this.logger.log(
        `intent (model) "${clip(utterance)}" → ${parsed.intent}/${parsed.place ?? '-'} ` +
          `from=${parsed.from ?? '-'} ms=${result.ms}`,
      );
      return parsed;
    } catch (err) {
      // 5초 예산이 걸린 자리다. 못 뽑으면 도움말로 넘어가는 게 맞다.
      this.logger.warn(`intent parse failed err=${err}`);
      return UNKNOWN_INTENT;
    }
  }
}

/**
 * 모델 없이 끝낼 수 있는 발화인가.
 *
 * 조건이 셋 다 맞아야 한다 — 의도가 키워드로 분명하고, 사전에 있는 도시가 하나 잡히고,
 * 출발지 표현이 없어야 한다. "서울에서 오사카" 처럼 지명이 둘이면 어느 쪽이 목적지인지
 * 사전으로는 못 가리므로 모델에 넘긴다. 틀린 지역으로 검색하는 것보다 낫다.
 */
export function fromKeywords(utterance: string): ParsedIntent | null {
  const intent = intentFromKeywords(utterance);
  if (intent === 'unknown') return null;
  if (/에서|출발/.test(utterance)) return null;

  const city = findCityInText(utterance);
  if (!city) return null;

  return {
    intent,
    place: city.nameKo,
    from: null,
    tripType: tripTypeOf(utterance),
    ignored: ignoredConditions(utterance),
  };
}

/** 모델(또는 캐시)이 준 값을 ParsedIntent 로 다듬는다. */
function normalize(raw: RawIntent, utterance: string): ParsedIntent {
  const intent = KINDS.has(String(raw.intent)) ? (raw.intent as SearchKind) : 'unknown';
  const place = text(raw.place);
  const modelIgnored = Array.isArray(raw.ignored) ? raw.ignored.map((v) => String(v)) : [];

  return {
    // ⚠️ place 가 없다고 unknown 으로 뭉개지 않는다. "호텔 추천해줘" 는 무엇을 원하는지
    //    분명하고, 그때는 도움말이 아니라 **어느 지역이냐고 되물어야** 한다.
    intent,
    place,
    from: text(raw.from),
    tripType: (raw.trip_type === 'ow' ? 'ow' : 'rt') as TripType,
    // 모델이 날짜를 빠뜨려도 고지는 나가야 한다. 정규식으로 한 번 더 훑는다.
    ignored: mergeIgnored(modelIgnored, utterance ? ignoredConditions(utterance) : []),
  };
}

function toRaw(parsed: ParsedIntent): RawIntent {
  return {
    intent: parsed.intent,
    place: parsed.place,
    from: parsed.from,
    trip_type: parsed.tripType,
    ignored: parsed.ignored,
  };
}

/** 문장 정규화 후 해시. 띄어쓰기·문장부호 차이는 같은 문장으로 본다. */
function hashOf(utterance: string): string {
  const key = utterance.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return createHash('sha256').update(key).digest('hex');
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

function clip(text: string): string {
  return text.slice(0, 40);
}

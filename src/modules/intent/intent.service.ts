import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { clip, text } from '../../common/parse';
import { AppConfig, CONFIG } from '../../config/app.config';
import { IntentCacheRepository } from '../database/repositories/intent-cache.repository';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';
import { AreaEntry, cityOfArea, findAreaInText, lookupArea } from '../places/area-table';
import {
  CityEntry,
  findCitiesInText,
  findOriginInText,
  lookupCity,
  tokenAfterCity,
} from '../places/city-table';
import { findCountryInText, lookupCountry, stripDomainWord } from '../places/country-table';
import { PlaceHint, PlaceKind } from '../places/places.types';
import { SearchKind } from '../search/search.types';
import {
  ParsedIntent,
  UNKNOWN_INTENT,
  fromCommand,
  ignoredConditions,
  intentFromKeywords,
  mergeIgnored,
  tripTypeOf,
  usableIgnored,
} from './intent.types';

/**
 * 발화 해석. **의도와 지역을 한 번에 뽑는다.**
 *
 *   "@가자고 오사카 호텔 4명 9월 22~24일 추천해줘"
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
  '나라 이름만 있어도(예: "베트남 여행지") place 에 그대로 넣는다 — 서버가 도시를 되묻는다.',
  'from 은 항공권의 출발지다. 말하지 않았으면 null 로 둔다. 서울이라고 추측하지 마라.',
  '"편도" 의미가 있으면 trip_type 은 ow, 아니면 rt 다.',
  'ignored 에는 날짜·인원·예산·테마(아이랑, 야경, 조용한 곳 등)처럼 검색에 반영할 수 없는 조건을 사용자가 말한 그대로 담는다.',
  // ⚠️ 아래가 예전에 두 번째 모델 호출이던 것이다. 같은 지명을 이미 읽고 있으므로
  //    여기서 같이 답하게 한다 — 왕복 하나가 통째로 빠진다.
  'place 를 정했으면 place_detail 에 그 지역이 무엇인지도 같이 적는다.',
  '나라면 kind=country, 도시면 kind=city, 도시 안의 구역·번화가면 kind=area, 단일 명소면 kind=landmark 다.',
  'area/landmark 면 그것이 속한 도시를 parent_name 에 한국어로 적는다 (도톤보리 → 오사카, 신주쿠 → 도쿄).',
  '도시에 대표 공항이 있으면 IATA 3자를 적는다 (오사카 → KIX). 없으면 null.',
  'place 가 null 이면 place_detail.canonical_name 도 null 이다.',
].join(' ');

const SCHEMA = {
  type: 'json_schema' as const,
  name: 'parsed_intent',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'place', 'from', 'trip_type', 'ignored', 'place_detail'],
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
      // ⚠️ **strict 모드는 모든 키가 required 여야 한다.** 빼면 스키마가 거절된다.
      //    "없음" 은 키를 생략하는 게 아니라 canonical_name 을 null 로 두는 것이다.
      place_detail: {
        type: 'object',
        additionalProperties: false,
        required: ['canonical_name', 'slug', 'country_code', 'kind', 'iata', 'parent_name'],
        properties: {
          canonical_name: {
            type: ['string', 'null'],
            description: '표준 한국어 지명. 오타 교정 후. place 가 없으면 null',
          },
          slug: { type: ['string', 'null'], description: '영문 소문자 슬러그. osaka, shinjuku' },
          country_code: { type: ['string', 'null'], description: 'ISO 3166-1 alpha-2. JP, KR' },
          kind: { type: 'string', enum: ['country', 'city', 'area', 'landmark'] },
          iata: { type: ['string', 'null'], description: '대표 공항 IATA 3자. 없으면 null' },
          parent_name: {
            type: ['string', 'null'],
            description: 'area/landmark 가 속한 도시의 한국어명. 도시·나라면 null',
          },
        },
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
  place_detail?: unknown;
}

interface CacheEntry {
  parsed: ParsedIntent;
  expiresAt: number;
}

/** 메모리 캐시 상한. 문장 하나당 한 칸이라 넉넉해도 가볍다. */
const MAX_ENTRIES = 5000;

const KINDS = new Set<string>(['hotel', 'flight', 'attraction']);

/** 로그에 남기는 발화 길이. 어떤 문장이었는지 알아볼 정도면 충분하다. */
const LOG_UTTERANCE = 40;

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
    const trimmed = utterance.trim();
    if (!trimmed) return UNKNOWN_INTENT;

    const hash = hashOf(trimmed);
    const cached = this.fromMemory(hash) ?? (await this.fromStore(hash, trimmed));
    if (cached) return cached;

    // 대표 명령어("여행지 오사카")는 의도가 확정이고 뒤가 곧 지명이다. 사전에 없는
    // 지명이어도 모델을 안 부른다 — 대표 명령어를 쓰는 사용자는 늘 0원이 된다.
    const command = fromCommand(trimmed);
    if (command) {
      this.logger.log(
        `intent (command) "${clip(trimmed, LOG_UTTERANCE)}" → ${command.intent}/${command.place}`,
      );
      return this.remember(hash, command);
    }

    const fast = fromKeywords(trimmed);
    if (fast) {
      this.logger.log(
        `intent (keyword) "${clip(trimmed, LOG_UTTERANCE)}" → ${fast.intent}/${fast.place}`,
      );
      return this.remember(hash, fast);
    }

    const parsed = await this.askModel(trimmed);
    // unknown 은 캐싱하지 않는다. 모델이 한 번 헛돈 것을 일주일씩 굳히면
    // 멀쩡한 질문이 그동안 계속 도움말로 떨어진다.
    if (parsed.intent === 'unknown') return this.degrade(trimmed, parsed.place, parsed.placeHint);
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
   *
   * ⚠️ **모델이 지명은 뽑아줬을 수 있다.** 의도만 못 잡은 경우가 그렇다
   *    ("베트남 여행지 추천해줘"). 그걸 버리고 null 로 만들면 지역을 말한 사람에게
   *    "어느 지역이세요?" 를 되묻는 꼴이 된다.
   */
  private degrade(
    utterance: string,
    place: string | null = null,
    placeHint: PlaceHint | null = null,
  ): ParsedIntent {
    const intent = intentFromKeywords(utterance);
    if (intent === 'unknown') return UNKNOWN_INTENT;
    return {
      intent,
      place,
      from: null,
      tripType: tripTypeOf(utterance),
      ignored: ignoredConditions(utterance),
      // 의도만 못 잡았을 뿐 지역은 제대로 읽었을 수 있다. 버리면 모델을 또 부른다.
      placeHint,
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

  /**
   * ⚠️ **발화를 같이 넘긴다.** 예전에는 빈 문자열을 넘겨서, 캐시에 굳은 엉뚱한
   *    `ignored` 를 걸러낼 방법이 없었다 — 모델이 한 번 발화를 통째로 담아 보내면
   *    그게 7일 동안 그대로 나갔다(INTENT_CACHE_TTL_MINUTES). 넘기면 `normalize` 가
   *    읽을 때마다 다시 거른다.
   */
  private async fromStore(hash: string, utterance: string): Promise<ParsedIntent | null> {
    if (!this.repo.enabled) return null;
    try {
      const raw = await this.repo.get(hash);
      if (!raw || typeof raw !== 'object') return null;
      const parsed = normalize(raw, utterance);
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
        this.logger.warn(`intent parse unreadable text=${clip(result.text, LOG_UTTERANCE)}`);
        return UNKNOWN_INTENT;
      }

      const parsed = normalize(raw, utterance);
      this.logger.log(
        `intent (model) "${clip(utterance, LOG_UTTERANCE)}" → ${parsed.intent}/${parsed.place ?? '-'} ` +
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

/** 출발지를 말한 흔적. 있으면 지명 둘 중 어느 쪽이 출발지인지부터 가려야 한다. */
const ORIGIN_HINT = /에서|출발/;

/**
 * 모델 없이 끝낼 수 있는 발화인가.
 *
 * 의도가 키워드로 분명하고 지명이 사전에 있어야 한다.
 *
 * ⚠️ **항공권에서 도시가 둘이면 앞이 출발지다** ("부산 하노이 항공권"). 노선을
 *    말하는 순서가 그렇고, 실제로 이렇게 들어온다. 예전에는 긴 쪽("하노이")만
 *    남기고 부산을 버려서 **부산 사람에게 서울 출발 항공권이 나갔다** — 게다가
 *    출발지를 추측했다는 고지(originAssumed)도 안 붙어 고칠 단서조차 없었다.
 *
 * ⚠️ **"인천에서 오사카" 도 여기서 끝낸다.** 예전에는 "에서"·"출발" 이 보이면
 *    무조건 모델에 넘겼는데, 그게 **항공권을 묻는 가장 흔한 말투**였다. 그래서
 *    가장 자연스럽게 물은 사람만 파서 모델(최대 4초)을 타고, 애드픽 변환까지
 *    겹치면 카카오 5초 예산을 넘겨 **말풍선이 통째로 안 나갔다.**
 *
 *    대신 조사를 믿는다 — 순서가 아니라 `findOriginInText` 가 "…에서" 가 붙은
 *    쪽을 출발지로 집는다. 순서로만 읽으면 "오사카 갈건데 인천에서 출발" 이
 *    오사카 출발이 된다.
 *
 * 호텔·관광지에 "에서" 가 붙으면 여전히 모델이 가른다. "제주에서 묵을" 의 제주는
 * 출발지가 아니라 목적지이고, 그 구분에는 순서도 조사도 소용이 없다.
 *
 * ⚠️ **도시 뒤에 모르는 말이 붙으면 그것도 모델이 가른다** ("도쿄 신주쿠"). 사전은
 *    도시까지만 알아서, 아는 도시 하나를 찾으면 거기서 확정하고 나머지를 버렸다 —
 *    신주쿠를 물은 사람이 **도쿄 호텔을 받았고 본인은 그 사실을 몰랐다.**
 */
export function fromKeywords(utterance: string): ParsedIntent | null {
  const intent = intentFromKeywords(utterance);
  if (intent === 'unknown') return null;

  const cities = findCitiesInText(utterance);
  const base = {
    intent,
    tripType: tripTypeOf(utterance),
    ignored: ignoredConditions(utterance),
  };

  if (ORIGIN_HINT.test(utterance)) {
    // 노선을 말한 항공권만 사전으로 가린다. 도시가 둘이 아니면 단서가 모자란다
    // ("서울에서 출발하는 항공권" 은 목적지가 없다).
    if (intent !== 'flight' || cities.length !== 2) return null;

    const origin = findOriginInText(utterance);
    const destination = origin ? cities.find((city) => city.slug !== origin.slug) : null;
    // "에서" 가 도시에 안 붙어 있다 ("이번에 오사카 도쿄 항공권"). 모델이 가른다.
    if (!origin || !destination) return null;

    return { ...base, place: destination.nameKo, from: origin.nameKo, placeHint: null };
  }

  if (intent === 'flight' && cities.length === 2) {
    return { ...base, place: cities[1].nameKo, from: cities[0].nameKo, placeHint: null };
  }

  // 도시가 먼저다. "일본 오사카 호텔" 은 오사카를 찾아야지 일본을 되물으면 안 된다.
  // 나라는 그다음 — 그러면 "일본 호텔 추천해줘" 도 모델 없이 되묻기까지 간다.
  // 도시가 둘 이상이면(위 항공권 경우가 아니면) 사전으로는 못 가린다 — 모델에 넘긴다.
  const only = cities.length === 1 ? cities[0] : null;

  if (only) {
    const next = tokenAfterCity(utterance, only);
    // **아는 세부 지역이면 여기서 끝낸다** ("부산 해운대", "도쿄 신주쿠").
    // 모델을 안 타므로 0ms 다 — 이 경로가 모델로 가면 응답 예산을 넘겨
    // "어떤 여행을 찾으시나요?" 가 나간다([area-table.ts](../places/area-table.ts)).
    const area = lookupArea(next, only);
    if (area) return { ...base, ...areaPlace(intent, area, only) };

    // ⚠️ **도시 뒤에 모르는 말이 붙어 있으면 그게 세부 지역이다** ("도쿄 기타센주").
    //    사전은 거기까지는 모른다. 여기서 안 넘기면 도시로 확정돼 **모델에 갈 기회가
    //    사라진다** — 그 동네를 물은 사람이 도쿄 호텔을 받고 본인은 모른다.
    if (looksLikeSubArea(next)) return null;
  }

  // 도시를 말하지 않고 동네만 말한 경우 ("해운대 호텔"). 도시가 하나라도 잡혔으면
  // 위에서 이미 갈렸으므로 여기는 도시가 아예 없을 때만 본다.
  if (!cities.length) {
    const area = findAreaInText(utterance);
    const parent = area ? cityOfArea(area) : null;
    if (area && parent) return { ...base, ...areaPlace(intent, area, parent) };
  }

  const place = only?.nameKo ?? (cities.length ? null : (findCountryInText(utterance)?.nameKo ?? null));
  if (!place) return null;

  // 사전 경로는 모델을 안 탄다 — 지역 정보도 같이 올 수 없다. 애초에 필요도 없다:
  // 사전이 아는 지명이므로 places 도 사전에서 찾는다.
  return { ...base, place, from: null, placeHint: null };
}

/**
 * 사전에서 찾은 세부 지역을 `ParsedIntent` 의 지명 칸으로.
 *
 * **지역 정보(PlaceHint)까지 같이 채운다.** 그래야 [places.service.ts](../places/places.service.ts)
 * 가 "신주쿠가 어디냐" 를 다시 묻지 않는다 — 발화 해석에서 모델을 아낀 보람이
 * 거기서 날아가면 아무것도 아니다.
 *
 * ⚠️ **항공권은 동네가 아니라 도시로 간다.** 동네에는 공항이 없어서
 *    ([link-offers.ts](../flight/link-offers.ts)) 노선을 못 만들고 카드가 빈다.
 *    "도쿄 신주쿠 항공권" 이 원하는 건 도쿄행이지 신주쿠행이 아니다.
 */
function areaPlace(
  intent: SearchKind,
  area: AreaEntry,
  city: CityEntry,
): Pick<ParsedIntent, 'place' | 'from' | 'placeHint'> {
  if (intent === 'flight') return { place: city.nameKo, from: null, placeHint: null };
  return {
    place: area.nameKo,
    from: null,
    placeHint: {
      canonicalName: area.nameKo,
      slug: area.slug,
      // 사전은 국내 도시에만 country 를 달아뒀다. 없으면 부모에서 채워진다.
      countryCode: city.country ?? null,
      kind: 'area',
      // 동네에는 공항이 없다. 있는 척하면 항공권이 그 코드로 노선을 만든다.
      iata: null,
      parentName: city.nameKo,
    },
  };
}

/**
 * 도메인 말·서술어·조건. **지명 자리에 올 수 없는 말들**이다.
 *
 * 접두 일치로 본다 — 한국어는 뒤에 어미가 붙는다("추천해줘"·"가는"·"좋은").
 */
const NOT_A_SUB_AREA =
  /^(호텔|숙소|숙박|리조트|호스텔|료칸|모텔|게하|게스트|민박|펜션|항공|비행|티켓|왕복|편도|관광|명소|볼거리|놀거리|맛집|구경|여행|가볼|가성비|추천|찾아|알려|검색|보여|예약|주세요|해줘|어디|어느|근처|주변|시내|중심|가는|가고|가려|갈|오는|있는|있나|좋은|괜찮|싼|저렴|비싼|제일|가장|진짜|완전|다른|같은|이번|담번|정도|말고|또는|그리고|뭐|좀)/;

/**
 * 이 토큰이 **세부 지역일 수 있는가.** 아니라고 확신할 때만 false 다.
 *
 * 틀리는 방향이 둘인데 값이 다르다 —
 *   · 지명인데 아니라고 하면 **엉뚱한 지역으로 검색**하고 사용자는 모른다
 *   · 지명이 아닌데 맞다고 하면 모델을 한 번 더 부른다. 결과는 어차피 같다
 * 그래서 애매하면 모델에 넘긴다. 비싼 쪽이 조용히 틀리는 쪽이다.
 */
function looksLikeSubArea(token: string | null): boolean {
  if (!token || token.length < 2) return false;
  // 한글만 본다. 영문·숫자 토큰(`best`·`2박`)은 지명으로 치지 않는다.
  if (!/^[가-힣]+$/.test(token)) return false;
  if (NOT_A_SUB_AREA.test(token)) return false;
  // 날짜·인원·테마는 이미 ignored 로 잡힌다 ("4명"·"가족이랑").
  if (ignoredConditions(token).length) return false;
  // 아는 지명이면 cities/countries 가 이미 들고 있다 — 여기서 또 셀 일이 아니다.
  if (lookupCity(token) || lookupCountry(token)) return false;
  return true;
}

/** 모델(또는 캐시)이 준 값을 ParsedIntent 로 다듬는다. */
function normalize(raw: RawIntent, utterance: string): ParsedIntent {
  const intent = KINDS.has(String(raw.intent)) ? (raw.intent as SearchKind) : 'unknown';
  // 모델이 발화를 덜 쪼개 "중국호텔" 을 통째로 줄 때가 있다. 그대로 두면 그 이름으로
  // 검색하고 "중국호텔 호텔 정보를 …" 같은 말이 나간다.
  const rawPlace = text(raw.place);
  const place = rawPlace ? stripDomainWord(rawPlace) || rawPlace : null;
  const modelIgnored = Array.isArray(raw.ignored) ? raw.ignored.map((v) => String(v)) : [];

  return {
    // ⚠️ place 가 없다고 unknown 으로 뭉개지 않는다. "호텔 추천해줘" 는 무엇을 원하는지
    //    분명하고, 그때는 도움말이 아니라 **어느 지역이냐고 되물어야** 한다.
    intent,
    place,
    from: text(raw.from),
    tripType: (raw.trip_type === 'ow' ? 'ow' : 'rt'),
    // ⚠️ **모델이 준 조건은 걸러서 쓴다.** 발화를 통째로 담아 보낼 때가 있고, 그러면
    //    "일부 조건(호텔, 찾아줘, 도쿄, 신주쿠)은 반영되지 않았어요" 가 나간다.
    //    모델이 날짜를 빠뜨려도 고지는 나가야 하므로 정규식으로 한 번 더 훑는다.
    ignored: mergeIgnored(
      usableIgnored(modelIgnored, utterance),
      utterance ? ignoredConditions(utterance) : [],
    ),
    placeHint: placeHintOf(raw.place_detail, place),
  };
}

/**
 * `place_detail` → [PlaceHint](../places/places.types.ts).
 *
 * ⚠️ **place 와 어긋나면 버린다.** 모델이 place 는 "신주쿠" 로 주고 detail 은 도쿄로
 *    주는 일이 있는데, 그걸 그대로 쓰면 신주쿠를 물은 사람의 place 가 도쿄로 등록되고
 *    **그 뒤로 영영 도쿄로 검색된다**(place_aliases 에 남는다). 어긋나면 안 쓰고
 *    places 가 평소대로 한 번 더 묻게 둔다 — 느린 게 조용히 틀린 것보다 낫다.
 */
function placeHintOf(detail: unknown, place: string | null): PlaceHint | null {
  if (!place || !detail || typeof detail !== 'object') return null;
  const raw = detail as Record<string, unknown>;

  const canonicalName = text(raw.canonical_name);
  if (!canonicalName) return null;

  const kind = String(raw.kind);
  if (!PLACE_KINDS.has(kind)) return null;

  return {
    canonicalName,
    slug: text(raw.slug),
    countryCode: text(raw.country_code),
    kind: kind as PlaceKind,
    iata: text(raw.iata),
    parentName: text(raw.parent_name),
  };
}

const PLACE_KINDS = new Set<string>(['country', 'city', 'area', 'landmark']);

function toRaw(parsed: ParsedIntent): RawIntent {
  return {
    intent: parsed.intent,
    place: parsed.place,
    from: parsed.from,
    trip_type: parsed.tripType,
    ignored: parsed.ignored,
    // ⚠️ **캐시에도 같이 넣는다.** 안 넣으면 캐시를 맞은 발화만 지역 정보를 잃고
    //    places 가 모델을 한 번 더 부른다 — 캐시가 느려지는 거꾸로 된 상황이 된다.
    place_detail: parsed.placeHint && {
      canonical_name: parsed.placeHint.canonicalName,
      slug: parsed.placeHint.slug,
      country_code: parsed.placeHint.countryCode,
      kind: parsed.placeHint.kind,
      iata: parsed.placeHint.iata,
      parent_name: parsed.placeHint.parentName,
    },
  };
}

/** 문장 정규화 후 해시. 띄어쓰기·문장부호 차이는 같은 문장으로 본다. */
function hashOf(utterance: string): string {
  const key = utterance.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return createHash('sha256').update(key).digest('hex');
}


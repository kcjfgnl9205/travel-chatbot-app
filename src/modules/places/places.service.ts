import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import {
  PlaceAliasesRepository,
  PlacesRepository,
} from '../database/repositories/places.repository';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';
import { CityEntry, lookupCity } from './city-table';
import { Place, PlaceDraft, PlaceKind, aliasKey, slugOf } from './places.types';

/**
 * 지역 정규화.
 *
 *   "오사카" · "osaka" · "오사카시"  → 같은 place
 *   "도톤보리"                      → 자기 place (parent: 오사카)
 *
 * **여기서 캐시 적중률이 결정된다.** 표기가 갈리면 같은 지역을 물어도 AI 검색이
 * 새로 돈다. 그래서 무엇을 받든 하나의 place_id 로 모으는 게 이 서비스의 전부다.
 *
 * 찾는 순서가 넷이다. 위에서 걸리면 아래는 안 본다.
 *
 *   1. **프로세스 메모리** — 같은 지역을 연달아 물었을 때. 0ms·0원
 *   2. **place_aliases** — 전에 누군가 물어봐서 등록된 지역
 *   3. **도시 사전**([city-table.ts](./city-table.ts)) — 237개. 0ms·0원이고 공항 코드가 딸려 온다
 *   4. **모델** — 사전에 없는 곳(도톤보리·해운대·시부야). 표준명·국가·종류를 물어 등록한다
 *
 * ⚠️ **지역을 검증하지 않는다.** "아는 도시인가?"를 묻지 않고 뽑힌 지명을 그대로
 *    쓴다. 모델까지 실패해도 원문으로 place 를 만들어 검색에 넘긴다 — 이것이
 *    세부 지역이 저절로 처리되는 이유이고, 동시에 "그런 도시 없어요" 로 사용자를
 *    막지 않는 이유다. 틀렸다면 검색 결과가 비는 것으로 드러난다.
 */

const INSTRUCTIONS = [
  '너는 여행 챗봇의 지역 정규화기다.',
  '사용자가 말한 지명을 표준 표기로 정리해 JSON 으로만 답한다.',
  '도시면 kind=city, 도시 안의 구역·번화가면 kind=area, 단일 명소면 kind=landmark 다.',
  'area/landmark 면 그것이 속한 도시를 parent_name 에 한국어로 적는다 (도톤보리 → 오사카).',
  '도시에 대표 공항이 있으면 IATA 3자를 적는다 (오사카 → KIX). 없으면 null.',
  '지명이 아니면 canonical_name 을 null 로 둔다.',
].join(' ');

const SCHEMA = {
  type: 'json_schema' as const,
  name: 'place_lookup',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['canonical_name', 'slug', 'country_code', 'kind', 'iata', 'parent_name'],
    properties: {
      canonical_name: {
        type: ['string', 'null'],
        description: '표준 한국어 지명. 오타 교정 후. 지명이 아니면 null',
      },
      slug: { type: ['string', 'null'], description: '영문 소문자 슬러그. osaka, dotonbori' },
      country_code: { type: ['string', 'null'], description: 'ISO 3166-1 alpha-2. JP, KR' },
      kind: { type: 'string', enum: ['city', 'area', 'landmark'] },
      iata: { type: ['string', 'null'], description: '대표 공항 IATA 3자. 없으면 null' },
      parent_name: {
        type: ['string', 'null'],
        description: 'area/landmark 가 속한 도시의 한국어명. 도시면 null',
      },
    },
  },
};

interface RawPlace {
  canonical_name?: unknown;
  slug?: unknown;
  country_code?: unknown;
  kind?: unknown;
  iata?: unknown;
  parent_name?: unknown;
}

/**
 * 메모리 별칭 캐시 상한. 지역 수만큼만 쌓이므로 가볍다.
 *
 * **만료시키지 않는다.** "동경"→도쿄 는 시간이 지나도 변하지 않는 사실이고,
 * 지역이 바뀌는 건 우리가 place 를 고칠 때뿐이다(그때는 재시작한다). 문장 해석처럼
 * 모델 변덕이 섞이는 값이 아니라서 TTL 을 둘 이유가 없다 — 두면 멀쩡한 캐시를
 * 주기적으로 버리고 같은 답을 다시 사게 된다.
 */
const MAX_ENTRIES = 5000;

@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);

  /** 별칭 → 지역. DB 가 있어도 여기서 먼저 막아야 조회가 5초 예산을 먹지 않는다. */
  private readonly aliases = new Map<string, Place>();
  private readonly byId = new Map<number, Place>();
  /** DB 가 없을 때 쓰는 번호표. 프로세스 안에서만 유효하다. */
  private nextLocalId = 1;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly places: PlacesRepository,
    private readonly placeAliases: PlaceAliasesRepository,
    private readonly openai: OpenAiService,
  ) {}

  /**
   * 지명 하나를 place 로 바꾼다. **실패하지 않는다** — 모르는 곳은 원문 그대로 등록한다.
   *
   * @param raw 발화에서 뽑힌 지명. "오사카", "도톤보리", "오사카시"
   */
  async resolve(raw: string | null | undefined): Promise<Place | null> {
    const key = aliasKey(raw ?? '');
    if (!key) return null;

    const cached = this.aliases.get(key);
    if (cached) return cached;

    const stored = await this.fromStore(key);
    if (stored) return this.remember(key, stored);

    const draft =
      draftFromTable(lookupCity(raw)) ?? (await this.askModel(raw ?? '')) ?? fallbackDraft(raw ?? '');
    const place = await this.register(draft);
    return this.remember(key, place);
  }

  /** 세부 지역의 부모 도시. 없으면 null. 카드 문구("도톤보리(오사카)")에 쓴다. */
  async parentOf(place: Place): Promise<Place | null> {
    if (place.parentId == null) return null;
    const local = this.byId.get(place.parentId);
    if (local) return local;
    if (!this.places.enabled) return null;
    const row = await this.places.findById(place.parentId);
    if (row) this.byId.set(row.id, row);
    return row;
  }

  /** 테스트·운영 점검용. 메모리 단만 비운다. */
  clearMemory(): void {
    this.aliases.clear();
    this.byId.clear();
  }

  // ---------------------------------------------------------------- 내부
  private async fromStore(key: string): Promise<Place | null> {
    if (!this.placeAliases.enabled) return null;
    try {
      const id = await this.placeAliases.placeIdOf(key);
      if (id == null) return null;
      return this.byId.get(id) ?? (await this.places.findById(id));
    } catch (err) {
      // DB 가 흔들려도 지역 해석은 계속돼야 한다. 사전·모델로 넘어간다.
      this.logger.warn(`place alias lookup failed key=${key} err=${err}`);
      return null;
    }
  }

  /**
   * 지역을 등록한다. DB 가 없으면 프로세스 메모리에만 남는다.
   *
   * DB 가 붙어 있을 때 upsert 를 쓰는 이유: 두 사람이 동시에 같은 새 지역을 물으면
   * 양쪽 다 insert 를 시도한다. 한쪽이 충돌로 죽으면 그 사람만 이유 없이 빈손이 된다.
   */
  private async register(draft: PlaceDraft): Promise<Place> {
    if (this.places.enabled) {
      const saved = await this.places.upsert(draft);
      if (saved) {
        this.byId.set(saved.id, saved);
        return saved;
      }
      this.logger.warn(`place upsert failed, falling back to memory: ${draft.canonicalName}`);
    }

    const local: Place = { ...draft, id: this.nextLocalId++ };
    this.byId.set(local.id, local);
    return local;
  }

  /**
   * 메모리에 얹고, DB 에도 별칭을 남긴다.
   *
   * 별칭은 세 개를 건다 — 사용자가 쓴 표기 · 표준명 · 슬러그. 다음 사람이 "osaka" 로
   * 물어도 같은 행에 닿아야 캐시가 갈리지 않는다.
   */
  private remember(key: string, place: Place): Place {
    for (const alias of new Set([key, aliasKey(place.canonicalName), aliasKey(place.slug)])) {
      if (!alias) continue;
      if (this.aliases.size >= MAX_ENTRIES) {
        // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
        const oldest = this.aliases.keys().next().value;
        if (oldest !== undefined) this.aliases.delete(oldest);
      }
      this.aliases.set(alias, place);
      if (this.placeAliases.enabled) {
        // 별칭 저장 때문에 응답이 늦어질 이유는 없다. 실패해도 다음에 다시 건다.
        void this.placeAliases.link(alias, place.id).catch(() => undefined);
      }
    }
    this.byId.set(place.id, place);
    return place;
  }

  /**
   * 사전에 없는 지명을 모델에게 묻는다.
   *
   * ⚠️ 이건 카카오 5초 예산 안에서 돈다. 짧게 끊고(OPENAI_PARSE_TIMEOUT_SECONDS),
   *    실패하면 원문 그대로 등록한다 — 되묻는 것보다 검색해 보는 게 낫다.
   */
  private async askModel(raw: string): Promise<PlaceDraft | null> {
    if (!this.openai.enabled) return null;

    try {
      const result = await this.openai.respond({
        instructions: INSTRUCTIONS,
        input: raw,
        model: this.config.openaiParseModel,
        effort: this.config.openaiParseEffort,
        format: SCHEMA,
        timeoutMs: this.config.openaiParseTimeoutMs,
      });

      const parsed = parseJsonLoose<RawPlace>(result.text);
      const name = text(parsed?.canonical_name);
      if (!parsed || !name) return null;

      const kind = KINDS.has(String(parsed.kind)) ? (parsed.kind as PlaceKind) : 'city';
      const parent = kind === 'city' ? null : await this.resolveParent(text(parsed.parent_name));

      this.logger.log(
        `place resolved by model "${raw}" → ${name}/${kind} parent=${parent?.canonicalName ?? '-'} ms=${result.ms}`,
      );
      return {
        canonicalName: name,
        slug: slugOf(text(parsed.slug) ?? name),
        countryCode: upper(parsed.country_code, 2) ?? parent?.countryCode ?? null,
        kind,
        iata: upper(parsed.iata, 3) ?? null,
        parentId: parent?.id ?? null,
      };
    } catch (err) {
      this.logger.warn(`place lookup failed raw=${raw} err=${err}`);
      return null;
    }
  }

  /** 부모 도시. 사전에 있으면 모델을 다시 부르지 않는다 (재귀를 한 단계로 끊는다). */
  private async resolveParent(name: string | null): Promise<Place | null> {
    if (!name) return null;
    const key = aliasKey(name);
    const cached = this.aliases.get(key);
    if (cached) return cached;

    const stored = await this.fromStore(key);
    if (stored) return this.remember(key, stored);

    const draft = draftFromTable(lookupCity(name));
    if (!draft) return null;
    return this.remember(key, await this.register(draft));
  }
}

const KINDS = new Set<string>(['city', 'area', 'landmark']);

/** 사전에서 온 도시. 공항 코드가 딸려 오는 게 모델 경로와의 차이다. */
function draftFromTable(city: CityEntry | null): PlaceDraft | null {
  if (!city) return null;
  return {
    canonicalName: city.nameKo,
    slug: city.slug,
    countryCode: null,
    kind: 'city',
    iata: city.iata,
    parentId: null,
  };
}

/**
 * 아무것도 못 알아냈을 때. **원문을 그대로 등록한다.**
 *
 * 되묻지 않는 이유: 사용자는 지명을 제대로 말했는데 우리가 모르는 경우가 대부분이고
 * (도톤보리·해운대·시부야), 그때 "어느 지역이세요?" 를 띄우면 같은 말을 또 하게 된다.
 * 검색을 시켜 보고, 정말 없으면 빈 결과로 드러난다.
 */
function fallbackDraft(raw: string): PlaceDraft {
  const name = raw.trim();
  return {
    canonicalName: name,
    slug: slugOf(name) || aliasKey(name),
    countryCode: null,
    // 도시라고 단정하지 않는다 — 사전에도 모델에도 없는 지명은 세부 지역일 확률이 높다.
    kind: 'area',
    iata: null,
    parentId: null,
  };
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

function upper(value: unknown, length: number): string | null {
  const t = text(value);
  if (!t || t.length !== length) return null;
  return t.toUpperCase();
}

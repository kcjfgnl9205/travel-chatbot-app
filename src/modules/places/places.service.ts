import { Inject, Injectable, Logger } from '@nestjs/common';

import { clip, text } from '../../common/parse';
import { AppConfig, CONFIG } from '../../config/app.config';
import {
  PlaceAliasesRepository,
  PlacesRepository,
} from '../database/repositories/places.repository';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';
import { CityEntry, lookupCity } from './city-table';
import { CountryEntry, lookupCountry } from './country-table';
import { CityChoice, Place, PlaceDraft, PlaceKind, aliasKey, slugOf } from './places.types';

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
  '나라면 kind=country, 도시면 kind=city, 도시 안의 구역·번화가면 kind=area, 단일 명소면 kind=landmark 다.',
  'area/landmark 면 그것이 속한 도시를 parent_name 에 한국어로 적는다 (도톤보리 → 오사카).',
  '도시에 대표 공항이 있으면 IATA 3자를 적는다 (오사카 → KIX). 없으면 null.',
  '지명이 아니면 canonical_name 을 null 로 둔다.',
  'kind=country 면 그 나라에서 한국인 여행자가 많이 가는 도시를 인기순으로 4곳까지 cities 에 담는다.',
  'cities 의 name 은 한국어 표준 도시명, blurb 는 대표 지역 두 곳(12자 이내)이다.',
  '나라가 아니면 cities 는 빈 배열이다.',
].join(' ');

const SCHEMA = {
  type: 'json_schema' as const,
  name: 'place_lookup',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['canonical_name', 'slug', 'country_code', 'kind', 'iata', 'parent_name', 'cities'],
    properties: {
      canonical_name: {
        type: ['string', 'null'],
        description: '표준 한국어 지명. 오타 교정 후. 지명이 아니면 null',
      },
      slug: { type: ['string', 'null'], description: '영문 소문자 슬러그. osaka, dotonbori' },
      country_code: { type: ['string', 'null'], description: 'ISO 3166-1 alpha-2. JP, KR' },
      kind: { type: 'string', enum: ['country', 'city', 'area', 'landmark'] },
      iata: { type: ['string', 'null'], description: '대표 공항 IATA 3자. 없으면 null' },
      parent_name: {
        type: ['string', 'null'],
        description: 'area/landmark 가 속한 도시의 한국어명. 도시·나라면 null',
      },
      cities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'blurb'],
          properties: {
            name: { type: 'string' },
            blurb: { type: 'string' },
          },
        },
        description: 'kind=country 일 때만. 대표 도시 4곳. 아니면 빈 배열',
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
  cities?: unknown;
}

const CITIES_INSTRUCTIONS = [
  '너는 여행 챗봇의 도시 추천기다.',
  '주어진 나라에서 한국인 여행자가 가장 많이 가는 도시를 인기순으로 4곳 뽑아 JSON 으로만 답한다.',
  'name 은 한국어 표준 도시명만 적는다. 수식어를 붙이지 않는다.',
  'blurb 는 그 도시의 대표 지역 두 곳을 " · " 로 이은 12자 이내 문자열이다 (예: "신주쿠 · 시부야").',
  '나라가 아니거나 모르면 빈 배열을 준다.',
].join(' ');

const CITIES_SCHEMA = {
  type: 'json_schema' as const,
  name: 'country_cities',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['cities'],
    properties: {
      cities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'blurb'],
          properties: {
            name: { type: 'string', description: '한국어 도시명' },
            blurb: { type: 'string', description: '대표 지역 두 곳. 12자 이내' },
          },
        },
        description: '인기순 4곳',
      },
    },
  },
};

/**
 * 나라 하나당 되묻기에 보여줄 도시 수.
 *
 * 4개다. listCard 는 5줄까지 들어가지만, 고르라고 내놓는 선택지는 적을수록 빨리
 * 고른다. 목록에 없는 도시는 카드 뒤 안내 말풍선이 받는다.
 */
const CITIES_PER_COUNTRY = 4;

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
  /** 나라 id → 되묻기에 쓸 도시들. 나라의 대표 도시는 변하지 않아 TTL 이 없다. */
  private readonly cities = new Map<number, CityChoice[]>();
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

    // 나라 → 도시 사전 → 모델 순. 앞의 둘은 0ms·0원이고 **판정이 매번 같다.**
    const known = draftFromCountry(lookupCountry(raw)) ?? draftFromTable(lookupCity(raw));
    const fromModel = known ? null : await this.askModel(raw ?? '');
    const draft = known ?? fromModel?.draft ?? fallbackDraft(raw ?? '');
    const place = await this.register(draft);

    // 나라를 해석하면서 도시 목록도 같이 받아둔다 — 되묻기에 모델을 한 번 더 부르지 않는다.
    if (place.kind === 'country' && fromModel?.cities?.length) {
      const cities = usableCities(fromModel.cities);
      if (cities.length) this.cities.set(place.id, cities);
    }
    return this.remember(key, place);
  }

  /**
   * 나라에서 되물을 도시 **이름**들.
   *
   * ⚠️ **이름만 돌려준다. 요청 경로에서 place 로 등록하지 않는다.**
   *    되묻기에 필요한 건 퀵리플라이 라벨뿐인데, 도시 6곳을 그 자리에서 resolve 하면
   *    사전에 없는 도시마다 모델이 한 번씩 나간다. 실측으로 **첫 질문이 25초**가 걸려
   *    카카오 5초 예산을 훌쩍 넘겼고, 사용자는 아무 말풍선도 못 받았다.
   *    등록은 백그라운드로 미룬다 — 다음 사람이 그 혜택을 본다.
   *
   * 순서가 셋이다. 위에서 걸리면 아래는 안 본다.
   *   1. 메모리 — 나라를 해석할 때 모델이 같이 준 목록이 여기 들어온다
   *   2. places 의 자식 — 전에 누가 물어봐서 이미 매달려 있다
   *   3. 모델 — 그래도 없으면 한 번 더 묻는다 (폴백)
   */
  async citiesOf(country: Place): Promise<CityChoice[]> {
    const cached = this.cities.get(country.id);
    if (cached?.length) return cached;

    const stored = (
      this.places.enabled
        ? await this.places.childrenOf(country.id, 'city')
        : [...this.byId.values()]
            .filter((p) => p.parentId === country.id && p.kind === 'city')
            .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    ).map((c) => ({ name: c.canonicalName, blurb: c.blurb ?? null }));

    // ⚠️ **모자라면 채운다.** 예전에는 저장된 게 하나라도 있으면 그대로 썼는데,
    //    그 결과 "중국 어느 도시…" 카드에 **도시가 둘**만, 그것도 설명 없이 나갔다.
    //    사전 경로로 먼저 등록된 도시는 순서(rank)도 설명(blurb)도 없이 들어온다.
    const enough =
      stored.length >= CITIES_PER_COUNTRY && stored.every((city) => Boolean(city.blurb));
    const cities = usableCities(enough ? stored : await this.askCities(country.canonicalName));
    if (!cities.length) return usableCities(stored);

    this.cities.set(country.id, cities);
    // 등록·보정은 나중에. 이번 응답은 이름과 설명만으로 충분하다.
    if (!enough) void this.linkCities(country, cities);
    return cities;
  }

  /**
   * 도시들을 나라 아래에 매단다. **백그라운드 전용이다.**
   *
   * 사전에 없는 도시는 여기서 모델을 타지만, 응답은 이미 나갔으므로 5초 예산과
   * 무관하다. 한 번 돌고 나면 그 나라는 DB 조회만으로 끝난다.
   */
  private async linkCities(country: Place, cities: CityChoice[]): Promise<void> {
    for (const [index, city] of cities.entries()) {
      try {
        const place = await this.resolve(city.name);
        if (place && place.kind === 'city') {
          await this.attachTo(place, country, index + 1, city.blurb);
          // 이미 매달려 있던 도시는 attachTo 가 건드리지 않는다(부모를 지키려고).
          // 순서와 설명은 그래도 최신으로 맞춘다 — 카드가 그걸로 그려진다.
          if (this.places.enabled) {
            await this.places
              .updateCityMeta(place.id, index + 1, city.blurb)
              .catch(() => undefined);
          }
        }
      } catch (err) {
        this.logger.warn(
          `city link failed country=${country.canonicalName} city=${city.name} err=${err}`,
        );
      }
    }
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
    this.cities.clear();
  }

  /** 도시를 나라 아래에 매단다. 이미 부모가 있으면 건드리지 않는다. */
  private async attachTo(
    city: Place,
    country: Place,
    rank: number,
    blurb: string | null,
  ): Promise<Place> {
    if (city.parentId != null) return city;

    if (this.places.enabled) {
      await this.places.attachCity(city.id, country.id, rank, blurb).catch(() => undefined);
    }
    const linked: Place = { ...city, parentId: country.id, rank, blurb };
    this.byId.set(linked.id, linked);
    for (const [alias, cached] of this.aliases) {
      if (cached.id === linked.id) this.aliases.set(alias, linked);
    }
    return linked;
  }

  /** 나라의 대표 도시 이름들. 실패하면 빈 배열 — 되묻기가 예시 도시로 떨어진다. */
  private async askCities(country: string): Promise<CityChoice[]> {
    if (!this.openai.enabled) return [];

    try {
      const result = await this.openai.respond({
        instructions: CITIES_INSTRUCTIONS,
        input: country,
        model: this.config.openaiParseModel,
        effort: this.config.openaiParseEffort,
        format: CITIES_SCHEMA,
        timeoutMs: this.config.openaiParseTimeoutMs,
      });

      const parsed = parseJsonLoose<{ cities?: unknown }>(result.text);
      const cities = toCityChoices(parsed?.cities);
      this.logger.log(
        `cities of ${country} → ${cities.map((c) => c.name).join(', ') || '-'} ms=${result.ms}`,
      );
      return cities;
    } catch (err) {
      this.logger.warn(`country cities lookup failed country=${country} err=${err}`);
      return [];
    }
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
  private async askModel(raw: string): Promise<{ draft: PlaceDraft; cities: CityChoice[] } | null> {
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
      if (!parsed || !name) {
        // ⚠️ 조용히 null 을 주면 원문 그대로 등록되고(kind=area) 나라가 지역으로 검색된다.
        //    로그가 없으면 "왜 되묻지 않지?" 를 영영 못 찾는다 — 실제로 그랬다.
        this.logger.warn(`place lookup returned no name raw=${raw} text=${clip(result.text, 120)}`);
        return null;
      }

      const kind = KINDS.has(String(parsed.kind)) ? (parsed.kind as PlaceKind) : 'city';
      const parent = kind === 'city' ? null : await this.resolveParent(text(parsed.parent_name));

      this.logger.log(
        `place resolved by model "${raw}" → ${name}/${kind} parent=${parent?.canonicalName ?? '-'} ms=${result.ms}`,
      );
      return {
        draft: {
          canonicalName: name,
          slug: slugOf(text(parsed.slug) ?? name),
          countryCode: upper(parsed.country_code, 2) ?? parent?.countryCode ?? null,
          kind,
          iata: upper(parsed.iata, 3) ?? null,
          parentId: parent?.id ?? null,
        },
        cities: toCityChoices(parsed.cities),
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

const KINDS = new Set<string>(['country', 'city', 'area', 'landmark']);

/**
 * 사전에서 온 나라.
 *
 * ⚠️ 모델에 맡기면 같은 "독일" 을 어떤 때는 country 로, 어떤 때는 도시처럼 봤다.
 *    그러면 나라가 지역 하나로 검색돼 뭉개진 결과가 나간다. 표가 이 흔들림을 없앤다.
 */
function draftFromCountry(country: CountryEntry | null): PlaceDraft | null {
  if (!country) return null;
  return {
    canonicalName: country.nameKo,
    slug: country.code.toLowerCase(),
    countryCode: country.code,
    kind: 'country',
    iata: null,
    parentId: null,
  };
}

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

/**
 * 되묻기 버튼에 쓸 수 있는 도시 이름만 남긴다.
 *
 * ⚠️ 모델이 가끔 원어를 그대로 준다 — 실제로 `Santiago de Compostela` 가 왔고,
 *    퀵리플라이 라벨이 14자라 **"Santiago de C…"** 로 잘려 나갔다. 잘린 영문 라벨은
 *    누를 마음이 안 든다. 한글이 아니거나 라벨이 잘릴 이름은 버린다 — 6곳 중 4곳만
 *    보여줘도 되묻기는 제 일을 한다.
 */
export function usableCities(cities: CityChoice[]): CityChoice[] {
  const seen = new Set<string>();
  return cities
    .map((city) => ({ name: city.name.trim(), blurb: city.blurb?.trim() || null }))
    .filter((city) => {
      if (!city.name || !/^[가-힣]/.test(city.name) || city.name.length > 8) return false;
      if (seen.has(city.name)) return false;
      seen.add(city.name);
      return true;
    })
    .slice(0, CITIES_PER_COUNTRY);
}

/** 모델이 준 배열을 CityChoice 로 다듬는다. 문자열만 온 경우도 받아준다. */
function toCityChoices(raw: unknown): CityChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return { name: item.trim(), blurb: null };
      const city = item as { name?: unknown; blurb?: unknown };
      return { name: String(city?.name ?? '').trim(), blurb: text(city?.blurb) };
    })
    .filter((city) => city.name);
}

function upper(value: unknown, length: number): string | null {
  const t = text(value);
  if (!t || t.length !== length) return null;
  return t.toUpperCase();
}

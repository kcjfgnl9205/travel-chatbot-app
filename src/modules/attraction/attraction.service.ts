import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { AppConfig, CONFIG, redirectUrl } from '../../config/app.config';
import { MemoryStoreService } from '../database/memory-store.service';
import { MessagesRepository } from '../database/repositories/messages.repository';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../database/repositories/recommendations.repository';
import { UsersRepository } from '../database/repositories/users.repository';
import * as t from '../kakao/templates';
import {
  KakaoSkillPayload,
  actionParamsOf,
  blockNameOf,
  callbackUrlOf,
  paramOf,
  userKeyOf,
  utteranceOf,
} from '../kakao/dto/skill-payload.dto';
import { CITIES, CITY_PARAMS, hasCity } from '../nlu/nlu';
import { NluService } from '../nlu/nlu.service';
import { SearchCacheService } from '../search-cache/search-cache.service';
import {
  ATTRACTION_PROVIDER,
  Attraction,
  AttractionProvider,
  AttractionQuery,
  attractionCacheKey,
  attractionKey,
  isAttraction,
  listDescription,
} from './attraction.types';

/**
 * 관광지 추천 유스케이스.
 *
 * 흐름은 호텔([hotel.service.ts](../hotel/hotel.service.ts))과 같다. 같은 제약
 * (카카오 5초 예산 / 느린 AI 검색)을 받으므로 같은 모양이 되는 게 맞다.
 *
 *   발화 파싱 → 사용자/메시지 로깅
 *     → 캐시 조회 (히트면 여기서 바로 응답)
 *     → 미스면 콜백 예약 후 백그라운드로: provider 검색(gpt-5-mini + 웹 검색)
 *     → 추천 저장 (+clickId 발급)
 *     → 카카오 listCard 조립 → callbackUrl 로 전송
 *
 * **호텔·항공권과 결정적으로 다른 점: 제휴 링크 단계가 통째로 없다.**
 * 관광지는 우리가 파는 게 아니라 장소라서 애드픽에 변환할 주소가 없다. 그래서
 * AffiliateService 를 주입하지 않고, 링크는 이름+도시로 만든 구글맵 주소다.
 * 그 덕에 rate limit 도, 변환 실패 폴백도, 죽은 링크 걱정도 없다.
 *
 * 그럼에도 `/r/{clickId}` 는 그대로 거친다. 수수료는 없어도 **어떤 관광지를
 * 눌렀는지**는 알아야 다음 추천이 나아진다 — 카카오 링크는 브라우저를 바로 열어서
 * 한 홉을 끼우지 않으면 아무 신호도 오지 않는다. 호텔과 같은 이유다.
 *
 * ⚠️ **provider.search() 를 요청 경로에서 부르면 안 된다.**
 *    카카오는 5초 안에 응답을 받아야 하는데 AI 검색은 7~30초가 걸린다.
 *    캐시 미스는 전부 백그라운드로 빠진다.
 */
const DOMAIN = 'attraction';

/** 빈 결과를 기억해두는 시간. 연타만 막으면 되므로 짧게 둔다. */
const EMPTY_RESULT_TTL_MS = 10 * 60_000;
const EMPTY_RESULT_MAX_ENTRIES = 500;

/** in-flight 병합·빈 결과 기억에 쓰는 키. 캐시 키와 같은 축을 쓴다. */
function searchKeyOf(provider: string, query: AttractionQuery): string {
  return [provider, ...attractionCacheKey(query).map((p) => p ?? '')].join(':');
}

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

/**
 * 같은 관광지가 리스트에 두 번 나가지 않게 한다.
 *
 * 이름으로 판정하면 '오사카성' / '오사카 성' / 'Osaka Castle' 이 전부 다른 값이 된다.
 * 지도 링크는 이름을 정규화해 만든 값이라 표기 흔들림을 어느 정도 흡수하고,
 * 무엇보다 **사용자가 도착하는 곳**이 같으면 같은 관광지다.
 */
export function dedupe(attractions: Attraction[], logger?: Logger): Attraction[] {
  const seen = new Set<string>();
  const unique: Attraction[] = [];
  for (const attraction of attractions) {
    const key = attractionKey(attraction);
    if (seen.has(key)) {
      logger?.log(`duplicate attraction dropped: ${attraction.name}`);
      continue;
    }
    seen.add(key);
    unique.push(attraction);
  }
  return unique;
}

/** 백그라운드 검색에 넘기는 요청 맥락. 응답을 나중에 조립할 때 필요하다. */
interface RequestContext {
  userId: string | null;
  messageId: string | null;
  started: number;
}

@Injectable()
export class AttractionService {
  private readonly logger = new Logger(AttractionService.name);

  /**
   * 진행 중인 검색. 같은 도시를 동시에 물으면 OpenAI 호출이 사람 수만큼 나간다.
   * 키 하나당 검색 하나로 묶는다.
   */
  private readonly inFlight = new Map<string, Promise<Attraction[]>>();

  /**
   * 방금 빈손으로 돌아온 검색 (키 → 만료 시각).
   *
   * 빈 결과는 캐시에 넣지 않는다 — 일시적 실패를 하루씩 굳히면 안 되니까.
   * 그런데 그것만 두면 "asdf 관광지" 를 연타할 때마다 OpenAI 호출이 나간다.
   */
  private readonly recentlyEmpty = new Map<string, number>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ATTRACTION_PROVIDER) private readonly provider: AttractionProvider,
    private readonly users: UsersRepository,
    private readonly messages: MessagesRepository,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly searchCache: SearchCacheService,
    private readonly nlu: NluService,
    private readonly memory: MemoryStoreService,
  ) {}

  // ------------------------------------------------------------ 진입점
  async handle(payload: KakaoSkillPayload): Promise<t.Json> {
    const started = Date.now();
    const utterance = utteranceOf(payload);
    // 호텔과 **같은 파서**를 쓴다. 뽑을 게 도시 하나로 같기 때문이다.
    // 별칭 캐시도 공유되므로 "오사카 호텔" 을 물어본 사람이 "오사카 관광지" 를
    // 물으면 파싱이 공짜다. 항공권만 노선·날짜 때문에 파서가 따로 있다.
    // cityOnly: 관광지는 인원·박수를 쓰지 않는다. 그걸 뽑자고 모델을 한 번 더
    // 부르면 5초 예산에서 아무 데도 안 쓰이는 값에 2.5초를 쓰는 셈이다.
    const parsed = await this.nlu.resolve(utterance, paramOf(payload, ...CITY_PARAMS), {
      cityOnly: true,
    });

    const user = await this.users.getOrCreate(userKeyOf(payload));
    const userId = (user?.id as string) ?? null;

    const message = await this.messages.log({
      userId,
      domain: DOMAIN,
      utterance,
      blockName: blockNameOf(payload),
      parsedCity: parsed.citySlug,
      params: actionParamsOf(payload),
      rawPayload: payload,
    });
    const messageId = (message?.id as string) ?? null;

    if (!hasCity(parsed)) return this.askCity();

    const query: AttractionQuery = {
      citySlug: parsed.citySlug ?? '',
      cityName: parsed.cityName ?? '',
      limit: this.config.attractionResultLimit,
    };
    const ctx: RequestContext = { userId, messageId, started };

    // 5초 예산 안에서 할 수 있는 건 캐시 조회까지다.
    const cached = await this.searchCache.peek(
      DOMAIN,
      this.provider.name,
      attractionCacheKey(query),
      isAttraction,
    );
    if (cached.length) {
      return this.respondWithAttractions(cached, query, { ...ctx, cacheHit: true });
    }

    // 방금 찾아봤는데 없었던 도시라면 또 부르지 않는다. 오타 연타가 곧 요금이다.
    if (this.wasRecentlyEmpty(query)) {
      this.logger.log(`skipping search, recently empty city=${query.cityName}`);
      return this.noResult(query.cityName);
    }

    // 미스 → 지금 응답할 수 없다. 검색은 백그라운드로 돌린다.
    const callbackUrl = callbackUrlOf(payload);
    // ⚠️ **콜백 URL 은 오픈빌더에서 그 블록의 [콜백 사용] 을 켠 경우에만 실린다.**
    //    꺼져 있으면 사용자는 "30초 뒤에 다시 물어봐 주세요" 를 받고 같은 질문을 두 번
    //    해야 한다. 분기는 여기 있으므로 그건 서버가 아니라 설정 문제다 — 어느 쪽인지
    //    로그로 남겨야 오픈빌더를 봐야 하는지 코드를 봐야 하는지 가릴 수 있다.
    if (!callbackUrl) {
      this.logger.warn(
        `callbackUrl 없음 — 오픈빌더에서 이 블록의 [콜백 사용] 이 꺼져 있다. ` +
          `block=${blockNameOf(payload) ?? '-'} domain=${DOMAIN}`,
      );
    }
    void this.searchInBackground(query, ctx, callbackUrl);

    return callbackUrl
      ? t.callbackAck(`${query.cityName} 관광지를 찾고 있어요. 잠시만요 🗺️`)
      : this.searchStarted(query.cityName);
  }

  // -------------------------------------------------------- 백그라운드 검색
  /**
   * provider 를 부르고, 결과를 캐시에 넣고, 콜백으로 카드를 보낸다.
   *
   * 요청 경로 밖에서 도는 코드라 **여기서 던진 예외는 아무도 못 받는다.**
   * 전부 삼키고 로그로만 남긴다. 콜백이 있으면 실패도 사용자에게 알린다.
   */
  private async searchInBackground(
    query: AttractionQuery,
    ctx: RequestContext,
    callbackUrl: string | null,
  ): Promise<void> {
    try {
      const attractions = await this.searchOnce(query);
      const response = attractions.length
        ? await this.respondWithAttractions(attractions, query, { ...ctx, cacheHit: false })
        : this.noResult(query.cityName);

      if (callbackUrl) await this.postCallback(callbackUrl, response);
    } catch (err) {
      this.logger.error(`background attraction search failed city=${query.cityName} err=${err}`);
      if (!callbackUrl) return;
      await this.postCallback(
        callbackUrl,
        t.simpleText(
          `${query.cityName} 관광지를 찾다가 문제가 생겼어요. 잠시 후 다시 시도해주세요 🙏`,
          this.cityQuickReplies(),
        ),
      );
    }
  }

  /** 같은 캐시 키의 검색을 하나로 묶는다. 끝나면 캐시에 저장한다. */
  private searchOnce(query: AttractionQuery): Promise<Attraction[]> {
    const key = searchKeyOf(this.provider.name, query);
    const running = this.inFlight.get(key);
    if (running) {
      this.logger.log(`attraction search already in flight, joining key=${key}`);
      return running;
    }

    const search = (async () => {
      const attractions = await this.provider.search(query);
      if (attractions.length) {
        await this.searchCache.store(
          DOMAIN,
          this.provider.name,
          attractionCacheKey(query),
          attractions,
          // 호텔·항공권보다 길다. 오사카의 볼거리는 어제와 오늘이 같다.
          this.config.attractionCacheTtlMinutes,
        );
      } else {
        this.rememberEmpty(key);
      }
      return attractions;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, search);
    return search;
  }

  private wasRecentlyEmpty(query: AttractionQuery): boolean {
    const key = searchKeyOf(this.provider.name, query);
    const until = this.recentlyEmpty.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.recentlyEmpty.delete(key);
    return false;
  }

  private rememberEmpty(key: string): void {
    // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
    if (this.recentlyEmpty.size >= EMPTY_RESULT_MAX_ENTRIES) {
      const oldest = this.recentlyEmpty.keys().next().value;
      if (oldest !== undefined) this.recentlyEmpty.delete(oldest);
    }
    this.recentlyEmpty.set(key, Date.now() + EMPTY_RESULT_TTL_MS);
  }

  /** 테스트·운영 점검용. 빈 결과 기억을 지운다. */
  forgetEmpty(): void {
    this.recentlyEmpty.clear();
  }

  /**
   * 완성된 스킬 응답을 카카오 콜백 주소로 보낸다.
   *
   * 카카오는 이 POST 를 1분 안에 받아야 하고, 응답 본문은 평소 스킬 응답과 같은 형식이다.
   * 실패해도 되돌릴 방법이 없으므로 로그만 남긴다.
   */
  private async postCallback(callbackUrl: string, body: t.Json): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.kakaoCallbackTimeoutMs);
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        this.logger.warn(`kakao callback rejected status=${res.status} body=${detail}`);
        return;
      }
      this.logger.log('kakao callback delivered');
    } catch (err) {
      this.logger.warn(`kakao callback failed err=${err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 진단용 — 이미 찾아둔 관광지로 **스킬과 똑같은 응답**을 조립한다.
   *
   * `/api/v1/debug/attraction-search` 가 쓴다. 카카오 경로는 5초 예산 때문에 검색을
   * 백그라운드로 던지므로, 진짜 카드가 어떻게 생겼는지는 콜백을 받아보기 전에는 알 수 없다.
   *
   * 통계는 남기지 않는다. 대신 clickId 는 인메모리에 남으므로 `/r/{clickId}` 는 동작한다.
   */
  async previewResponse(
    attractions: Attraction[],
    query: AttractionQuery,
    opts: { started: number },
  ): Promise<t.Json> {
    if (!attractions.length) return this.noResult(query.cityName);
    return this.respondWithAttractions(attractions, query, {
      userId: null,
      messageId: null,
      started: opts.started,
      cacheHit: false,
      persist: false,
    });
  }

  // ------------------------------------------------------- 응답 조립
  private async respondWithAttractions(
    input: Attraction[],
    query: AttractionQuery,
    ctx: {
      userId: string | null;
      messageId: string | null;
      started: number;
      cacheHit: boolean;
      /**
       * 통계(recommendations·recommendation_items)를 남길지. 기본 true.
       * 진단 경로만 false 로 둔다 — 진단 호출이 섞이면 전환율 집계가 틀어진다.
       */
      persist?: boolean;
    },
  ): Promise<t.Json> {
    // 중복 제거 → 자르기 순서가 중요하다. 반대로 하면 중복이 5줄 자리를 먹는다.
    const attractions = dedupe(input, this.logger).slice(0, t.MAX_LIST_ITEMS);

    const recommendation =
      ctx.persist === false
        ? null
        : await this.recommendations.create({
            userId: ctx.userId,
            messageId: ctx.messageId,
            domain: DOMAIN,
            citySlug: query.citySlug,
            provider: this.provider.name,
            itemCount: attractions.length,
            guests: null,
            latencyMs: Date.now() - ctx.started,
            cacheHit: ctx.cacheHit,
          });
    const recommendationId = (recommendation?.id as string) ?? null;

    const rows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];

    attractions.forEach((attraction, position) => {
      const clickId = newClickId();
      // 목적지가 곧 지도 링크다. 애드픽 변환이 없으므로 폴백도 실패도 없다.
      const targetUrl = attraction.mapUrl;

      rows.push({
        recommendation_id: recommendationId,
        // 제휴 링크가 없는 도메인이다. 이 컬럼이 null 인 게 정상이다.
        affiliate_link_id: null,
        position,
        click_id: clickId,
        hotel_name: attraction.name,
        // ⚠️ **입장료를 price_from 에 넣지 않는다.**
        //
        // 그 칸은 호텔 1박가·항공 운임이 들어가는 자리이고 단위가 **원**이다.
        // 관광지 입장료는 현지 통화(엔·바트·동)라 같은 칸에 넣으면 비교 불가능한
        // 숫자가 섞인다 — 통화 컬럼도 없으므로 나중에 누가 합계를 내면 조용히 틀린다.
        // 입장료는 카드와 search_cache 에만 남기고, 집계 대상으로는 두지 않는다.
        // (환율 API 를 붙여 원화로 확정할 수 있게 되면 그때 채우면 된다)
        price_from: null,
        merchant: null,
        // 위키백과에서 찾은 사진. 못 구한 관광지는 null 이다 (실측 87% 가 채워진다).
        thumbnail_url: attraction.imageUrl ?? null,
        source_url: attraction.mapUrl,
        target_url: targetUrl,
      });

      // DB가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        itemName: attraction.name,
        sourceUrl: attraction.mapUrl,
        targetUrl,
        userId: ctx.userId,
      });

      // 줄 전체가 링크가 된다. 링크는 구글맵이 아니라 우리 리다이렉트를 가리킨다 —
      // 그래야 어떤 관광지를 눌렀는지 남는다.
      listItems.push(
        t.listItem({
          title: attraction.name,
          description: listDescription(attraction),
          // 없으면 listItem 이 알아서 뺀다 — 그 줄만 사진 없이 나간다.
          // 호텔도 썸네일을 못 구하면 같은 모양이라 새로운 상태는 아니다.
          imageUrl: attraction.imageUrl,
          linkUrl: redirectUrl(this.config, clickId),
        }),
      );
    });

    if (!listItems.length) return this.noResult(query.cityName);
    if (recommendationId) await this.items.createMany(rows);

    return t.listCard({
      headerTitle: `${query.cityName} 관광지 ${listItems.length}곳`,
      items: listItems,
      buttons: buttonsFor(attractions),
      quickReplies: this.cityQuickReplies(query.citySlug),
    });
  }

  // ------------------------------------------------------- 예외 응답
  askCity(): t.Json {
    return t.simpleText(
      '어느 도시 관광지를 찾으세요?\n예) 오사카 관광지 추천해줘',
      this.cityQuickReplies(),
    );
  }

  private noResult(cityName: string): t.Json {
    return t.simpleText(
      `${cityName} 관광지를 찾지 못했어요. 도시 이름을 다시 확인해주세요!`,
      this.cityQuickReplies(),
    );
  }

  /**
   * 콜백이 꺼져 있을 때의 미스 응답.
   *
   * 검색은 이미 백그라운드에서 돌고 있다. 다시 물으면 캐시에서 바로 나간다 —
   * 콜백 없이 20초를 기다리게 할 방법이 없어서 차선책으로 둔 경로다.
   */
  private searchStarted(cityName: string): t.Json {
    return t.simpleText(
      `${cityName} 관광지를 찾고 있어요 🗺️\n30초쯤 뒤에 다시 물어봐 주세요!`,
      this.cityQuickReplies(),
    );
  }

  cityQuickReplies(exclude?: string | null): t.Json[] {
    return CITIES.filter((c) => c.slug !== exclude).map((c) =>
      t.quickReply(`${c.nameKo} 관광지`, `${c.nameKo} 관광지 추천해줘`),
    );
  }
}

/** 위키미디어 공용의 라이선스 안내. 출처 버튼이 여기로 간다. */
const PHOTO_CREDIT_URL = 'https://commons.wikimedia.org/wiki/Commons:Licensing';

/**
 * 카드 하단 버튼. listCard 는 2개가 한계다.
 *
 * 사진이 한 장이라도 실렸을 때만 출처 버튼을 단다. 위키미디어 사진은 대부분
 * CC BY-SA 라 저작자 표시가 필요한데, listCard 한 줄에는 링크가 하나뿐이고
 * 그 자리는 지도가 써야 한다(클릭 추적). 줄마다 출처를 달 자리가 없어서
 * 카드 단위로 밝힌다.
 *
 * ⚠️ **엄밀한 의미의 CC BY-SA 표시는 아니다.** 저작자와 라이선스를 사진마다
 *    밝히는 게 원칙이고, 이건 출처가 어디인지만 알린다. 사진을 카드 밖(웹·앱)에서
 *    쓰게 되면 그때는 제대로 된 표시가 필요하다.
 */
export function buttonsFor(attractions: Attraction[]): t.Json[] {
  const buttons = [t.messageButton('다른 도시 보기', '관광지 추천해줘')];
  if (attractions.some((a) => a.imageUrl)) {
    buttons.push(t.webLinkButton('사진 출처: 위키미디어', PHOTO_CREDIT_URL));
  }
  return buttons;
}

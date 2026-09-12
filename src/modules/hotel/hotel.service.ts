import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { applySubid } from '../adpick/adpick.service';
import { AffiliateService, ResolvedLink } from '../affiliate/affiliate.service';
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
  PAGE_SIZE,
  cityFromExtra,
  hasNextPage,
  moreButton,
  offsetOf,
  pageOf,
} from '../kakao/paging';
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
  HOTEL_PROVIDER,
  Hotel,
  HotelProvider,
  HotelQuery,
  hotelCacheKey,
  isHotel,
  listDescription,
} from './hotel.types';

/**
 * 호텔 추천 유스케이스.
 *
 * 컨트롤러는 얇게 두고 흐름은 전부 여기 모은다.
 *
 *   발화 파싱 → 사용자/메시지 로깅
 *     → 캐시 조회 (히트면 여기서 바로 응답)
 *     → 미스면 콜백 예약 후 백그라운드로: provider 검색(gpt-5-mini + 웹 검색)
 *     → 원본 주소 → 애드픽 커미션 링크 변환 (캐시 우선)
 *     → 추천 저장 (+clickId 발급)
 *     → 카카오 listCard 조립 → callbackUrl 로 전송
 *
 * 사용자에게 노출되는 건 우리 리다이렉트(`/r/{clickId}`)뿐이고,
 * 그 302 목적지가 애드픽 커미션 링크다. 원본 주소는 DB에만 남는다.
 *
 * ⚠️ **provider.search() 를 요청 경로에서 부르면 안 된다.**
 *    카카오는 5초 안에 응답을 받아야 하는데 AI 검색은 7~30초가 걸린다.
 *    캐시 미스는 전부 백그라운드로 빠진다.
 */
const DOMAIN = 'hotel';

/** 빈 결과를 기억해두는 시간. 연타만 막으면 되므로 짧게 둔다. */
const EMPTY_RESULT_TTL_MS = 10 * 60_000;
const EMPTY_RESULT_MAX_ENTRIES = 500;

/** in-flight 병합·빈 결과 기억에 쓰는 키. 캐시 키와 같은 축을 쓴다. */
function searchKeyOf(provider: string, query: HotelQuery): string {
  return `${provider}:${query.citySlug}:${query.guests ?? ''}:${query.limit}`;
}

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

/**
 * 같은 호텔이 리스트에 두 번 나가지 않게 한다.
 *
 * AI provider 는 같은 호텔을 이름만 다르게 여러 번 주기도 한다
 * ('호텔 그란비아 오사카' / 'Hotel Granvia Osaka').
 * 이름은 못 믿으므로 sourceUrl(호텔 신원)로 판정한다.
 */
export function dedupe(hotels: Hotel[], logger?: Logger): Hotel[] {
  const seen = new Set<string>();
  const unique: Hotel[] = [];
  for (const hotel of hotels) {
    const key = hotel.sourceUrl || hotel.name;
    if (seen.has(key)) {
      logger?.log(`duplicate hotel dropped: ${hotel.name} (${key})`);
      continue;
    }
    seen.add(key);
    unique.push(hotel);
  }
  return unique;
}

/** 백그라운드 검색에 넘기는 요청 맥락. 응답을 나중에 조립할 때 필요하다. */
interface RequestContext {
  userId: string | null;
  messageId: string | null;
  guests: number | null;
  started: number;
  /** 이번 카드가 보여줄 시작 위치. "더 보기" 로 들어오면 5, 첫 요청이면 0. */
  offset?: number;
}

@Injectable()
export class HotelService {
  private readonly logger = new Logger(HotelService.name);

  /**
   * 진행 중인 검색. 같은 도시를 동시에 물으면 OpenAI 호출이 사람 수만큼 나간다.
   * 키 하나당 검색 하나로 묶는다.
   */
  private readonly inFlight = new Map<string, Promise<Hotel[]>>();

  /**
   * 방금 빈손으로 돌아온 검색 (키 → 만료 시각).
   *
   * 빈 결과는 캐시에 넣지 않는다 — 일시적 실패를 한 시간씩 굳히면 안 되니까.
   * 그런데 그것만 두면 "asdf 호텔 추천해줘" 를 연타할 때마다 OpenAI 호출이 나간다.
   * 검색 결과 캐시보다 훨씬 짧게, 연타만 막을 만큼만 기억한다.
   */
  private readonly recentlyEmpty = new Map<string, number>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(HOTEL_PROVIDER) private readonly provider: HotelProvider,
    private readonly users: UsersRepository,
    private readonly messages: MessagesRepository,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly affiliate: AffiliateService,
    private readonly searchCache: SearchCacheService,
    private readonly nlu: NluService,
    private readonly memory: MemoryStoreService,
  ) {}

  // ------------------------------------------------------------ 진입점
  async handle(payload: KakaoSkillPayload): Promise<t.Json> {
    const started = Date.now();
    const utterance = utteranceOf(payload);
    // 모델 호출이 들어간다(캐시 미스일 때만). 5초 예산의 첫 지출이라 타임아웃이 짧다.
    // "호텔 더 보기" 처럼 발화에 도시가 없는 경우가 있다. 그때는 버튼이 실어 보낸
    // clientExtra.city 가 유일한 단서다 — 엔티티 파라미터와 같은 자격으로 본다.
    const parsed = await this.nlu.resolve(
      utterance,
      paramOf(payload, ...CITY_PARAMS) ?? cityFromExtra(payload),
    );

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

    const query: HotelQuery = {
      citySlug: parsed.citySlug ?? '',
      cityName: parsed.cityName ?? '',
      guests: parsed.guests,
      limit: this.config.hotelResultLimit,
    };
    const ctx: RequestContext = {
      userId,
      messageId,
      guests: parsed.guests,
      started,
      offset: offsetOf(payload),
    };

    // 5초 예산 안에서 할 수 있는 건 캐시 조회까지다.
    const cached = await this.searchCache.peek(
      DOMAIN,
      this.provider.name,
      hotelCacheKey(query),
      isHotel,
    );
    if (cached.length) {
      return this.respondWithHotels(cached, query, { ...ctx, cacheHit: true });
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
      ? t.callbackAck(`${query.cityName} 호텔을 찾고 있어요. 잠시만요 🔍`)
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
    query: HotelQuery,
    ctx: RequestContext,
    callbackUrl: string | null,
  ): Promise<void> {
    try {
      const hotels = await this.searchOnce(query);
      const response = hotels.length
        ? await this.respondWithHotels(hotels, query, { ...ctx, cacheHit: false })
        : this.noResult(query.cityName);

      if (callbackUrl) await this.postCallback(callbackUrl, response);
    } catch (err) {
      this.logger.error(`background hotel search failed city=${query.cityName} err=${err}`);
      if (!callbackUrl) return;
      await this.postCallback(
        callbackUrl,
        t.simpleText(
          `${query.cityName} 호텔을 찾다가 문제가 생겼어요. 잠시 후 다시 시도해주세요 🙏`,
          this.cityQuickReplies(),
        ),
      );
    }
  }

  /** 같은 캐시 키의 검색을 하나로 묶는다. 끝나면 캐시에 저장한다. */
  private searchOnce(query: HotelQuery): Promise<Hotel[]> {
    const key = searchKeyOf(this.provider.name, query);
    const running = this.inFlight.get(key);
    if (running) {
      this.logger.log(`search already in flight, joining key=${key}`);
      return running;
    }

    const search = (async () => {
      const hotels = await this.provider.search(query);
      if (hotels.length) {
        await this.searchCache.store(DOMAIN, this.provider.name, hotelCacheKey(query), hotels);
      } else {
        this.rememberEmpty(key);
      }
      return hotels;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, search);
    return search;
  }

  private wasRecentlyEmpty(query: HotelQuery): boolean {
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
   * 진단용 — 이미 찾아둔 호텔로 **스킬과 똑같은 응답**을 조립한다.
   *
   * `/api/v1/debug/hotel-search` 가 쓴다. 카카오 경로는 5초 예산 때문에 검색을
   * 백그라운드로 던지므로, 진짜 카드가 어떻게 생겼는지는 콜백을 받아보기 전에는 알 수 없다.
   * 여기를 거치면 **같은 조립 코드를 그대로 태워서** 미리 볼 수 있다 —
   * 진단용으로 카드를 따로 만들면 그건 실제 응답을 검증하는 게 아니다.
   *
   * 통계는 남기지 않는다. 대신 clickId 는 인메모리에 남으므로 `/r/{clickId}` 는 동작한다.
   */
  async previewResponse(
    hotels: Hotel[],
    query: HotelQuery,
    opts: { started: number; links: Map<string, ResolvedLink> },
  ): Promise<t.Json> {
    if (!hotels.length) return this.noResult(query.cityName);
    return this.respondWithHotels(hotels, query, {
      userId: null,
      messageId: null,
      guests: query.guests ?? null,
      started: opts.started,
      cacheHit: false,
      persist: false,
      links: opts.links,
    });
  }

  // ------------------------------------------------------- 응답 조립
  private async respondWithHotels(
    input: Hotel[],
    query: HotelQuery,
    ctx: {
      userId: string | null;
      messageId: string | null;
      guests: number | null;
      started: number;
      cacheHit: boolean;
      offset?: number;
      /**
       * 통계(recommendations·recommendation_items)를 남길지. 기본 true.
       * 진단 경로만 false 로 둔다 — 진단 호출이 섞이면 전환율 집계가 틀어진다.
       */
      persist?: boolean;
      /**
       * 미리 해석해둔 제휴 링크. 주면 애드픽을 다시 부르지 않는다.
       * 빈 Map 은 "변환하지 않는다"는 뜻이고, 그때 목적지는 원본 주소가 된다.
       *
       * 어느 쪽이든 **카드 JSON 은 같다** — 줄 링크는 `/r/{clickId}` 이고
       * 애드픽 주소는 그 302 목적지로만 쓰인다.
       */
      links?: Map<string, ResolvedLink>;
    },
  ): Promise<t.Json> {
    // 중복 제거 → 페이지 자르기 순서가 중요하다. 반대로 하면 중복이 줄 자리를 먹고,
    // 2페이지에서 1페이지에 이미 나온 호텔이 다시 보인다.
    // 자르기 전에 애드픽 변환을 돌리지 않는 이유도 같다 — 이번 페이지에 안 나갈
    // 호텔 때문에 rate limit 을 헛되이 쓴다.
    const all = dedupe(input, this.logger);
    const { page: hotels, start } = pageOf(all, ctx.offset ?? 0);

    // 원본 주소 → 애드픽 커미션 링크. 캐시에 있으면 API 를 안 탄다.
    // affiliate_links 행이 곧 호텔의 신원이기도 하다 — 별도 호텔 마스터를 두지 않는다.
    const links =
      ctx.links ??
      (await this.affiliate.resolve(
        hotels
          .filter((h) => h.sourceUrl)
          .map((h) => ({ sourceUrl: h.sourceUrl, merchant: h.merchant })),
      ));

    // persist:false 면 통계를 안 남긴다. recommendationId 가 null 이 되고,
    // 아래 items.createMany 도 자연히 건너뛴다 (같은 조건을 이미 쓰고 있다).
    const recommendation =
      ctx.persist === false
        ? null
        : await this.recommendations.create({
            userId: ctx.userId,
            messageId: ctx.messageId,
            domain: DOMAIN,
            citySlug: query.citySlug,
            provider: this.provider.name,
            itemCount: hotels.length,
            guests: ctx.guests,
            latencyMs: Date.now() - ctx.started,
            cacheHit: ctx.cacheHit,
          });
    const recommendationId = (recommendation?.id as string) ?? null;

    const rows: Record<string, unknown>[] = [];
    const listItems: t.Json[] = [];
    /** 애드픽 변환이 안 돼 원본 주소로 나가는 줄. 수익화가 안 되는 노출이다. */
    const unconverted: string[] = [];

    hotels.forEach((hotel, position) => {
      const clickId = newClickId();
      const link = links.get(hotel.sourceUrl);
      // 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 호텔을 본다.
      const destination = link?.affiliateUrl ?? hotel.sourceUrl;
      if (!destination) {
        this.logger.warn(`no destination for hotel=${hotel.name}, skipping row`);
        return;
      }
      // 목적지가 원본과 같다 = 커미션 링크가 아니다.
      // 여기서 세지 않으면 "링크는 잘 열리는데 수수료가 안 들어온다"를 영영 못 찾는다.
      if (destination === hotel.sourceUrl) unconverted.push(hotel.name);
      const targetUrl = applySubid(destination, clickId, this.config);

      rows.push({
        recommendation_id: recommendationId,
        affiliate_link_id: link?.affiliateLinkId ?? null,
        position,
        click_id: clickId,
        hotel_name: hotel.name,
        price_from: hotel.priceFrom ?? null,
        merchant: hotel.merchant ?? null,
        thumbnail_url: hotel.thumbnailUrl ?? null,
        source_url: hotel.sourceUrl,
        target_url: targetUrl,
      });

      // DB가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        itemName: hotel.name,
        sourceUrl: hotel.sourceUrl,
        targetUrl,
        userId: ctx.userId,
      });

      // 줄 전체가 링크가 된다. 링크는 애드픽이 아니라 우리 리다이렉트를 가리킨다.
      listItems.push(
        t.listItem({
          title: hotel.name,
          description: listDescription(hotel),
          imageUrl: hotel.thumbnailUrl,
          linkUrl: redirectUrl(this.config, clickId),
        }),
      );
    });

    if (unconverted.length) {
      // 경고로 남긴다. 배포를 막을 일은 아니지만 방치하면 그대로 매출이 샌다.
      this.logger.warn(
        `애드픽 변환 실패 ${unconverted.length}/${listItems.length}건 — 원본 주소로 나간다: ` +
          unconverted.join(', '),
      );
    }

    if (!listItems.length) return this.noResult(query.cityName);
    if (recommendationId) await this.items.createMany(rows);

    return t.listCard({
      // 2페이지부터는 몇 번째인지 알려준다. 안 그러면 같은 카드가 또 온 것처럼 보인다.
      headerTitle: start
        ? `${query.cityName} 호텔 ${start + 1}~${start + listItems.length}번째`
        : `${query.cityName} 호텔 추천 ${listItems.length}곳`,
      items: listItems,
      buttons: this.buttonsFor(query, all.length, start),
      quickReplies: this.cityQuickReplies(query.citySlug),
    });
  }

  // ------------------------------------------------------- 예외 응답
  askCity(): t.Json {
    return t.simpleText(
      '어느 도시 호텔을 찾으세요?\n예) 오사카 호텔 추천해줘',
      this.cityQuickReplies(),
    );
  }

  private noResult(cityName: string): t.Json {
    return t.simpleText(
      `${cityName} 호텔을 찾지 못했어요. 도시 이름을 다시 확인해주세요!`,
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
      `${cityName} 호텔을 찾고 있어요 🔍\n30초쯤 뒤에 다시 물어봐 주세요!`,
      this.cityQuickReplies(),
    );
  }

  /**
   * 카드 하단 버튼. **"더 보기" 하나뿐이고, 다음 페이지가 있을 때만 단다.**
   *
   * 예전 '다른 도시 보기' 는 뺐다. 누르면 도시 없는 문장("호텔 추천해줘")이 가서
   * 되묻기만 나왔다 — **호텔이 안 나오는 버튼**이었다. 도시 전환은 quickReplies 가
   * 이미 하고 있으므로(도쿄 호텔 · 오사카 호텔 …) 두 칸뿐인 버튼 자리를 쓸 이유가 없다.
   *
   * 남은 게 없으면 버튼이 아예 없다. 그게 맞다 — 눌러도 같은 5곳이 다시 나오면
   * 사용자는 그걸 고장으로 읽는다.
   */
  private buttonsFor(query: HotelQuery, total: number, start: number): t.Json[] {
    if (!hasNextPage(total, start)) return [];
    return [
      moreButton({
        style: this.config.moreButtonStyle,
        blockId: this.config.hotelBlockId,
        messageText: `${query.cityName} 호텔 더 보기`,
        cityName: query.cityName,
        nextOffset: start + PAGE_SIZE,
      }),
    ];
  }

  cityQuickReplies(exclude?: string | null): t.Json[] {
    return CITIES.filter((c) => c.slug !== exclude).map((c) =>
      t.quickReply(`${c.nameKo} 호텔`, `${c.nameKo} 호텔 추천해줘`),
    );
  }
}

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
  KakaoSkillPayload,
  actionParamsOf,
  blockNameOf,
  callbackUrlOf,
  paramOf,
  userKeyOf,
  utteranceOf,
} from '../kakao/dto/skill-payload.dto';
import { CITIES } from '../nlu/nlu';
import {
  DEPART_PARAMS,
  DEST_PARAMS,
  FlightNluService,
  ORIGIN_PARAMS,
  ParsedFlight,
  RETURN_PARAMS,
  hasRoute,
} from '../nlu/flight-nlu.service';
import { SearchCacheService } from '../search-cache/search-cache.service';
import {
  FLIGHT_PROVIDER,
  Flight,
  FlightProvider,
  FlightQuery,
  cabinText,
  cardRows,
  listRowDescription,
  listRowTitle,
  dateLabel,
  flightCacheKey,
  flightKey,
  isFlight,
  priceText,
} from './flight.types';

/**
 * 항공권 검색 유스케이스.
 *
 * 흐름은 호텔([hotel.service.ts](../hotel/hotel.service.ts))과 같다. 같은 제약
 * (카카오 5초 예산 / 느린 AI 검색 / 애드픽 rate limit)을 받으므로 같은 모양이 되는 게 맞다.
 *
 *   발화 파싱 → 사용자/메시지 로깅
 *     → 캐시 조회 (히트면 여기서 바로 응답)
 *     → 미스면 콜백 예약 후 백그라운드로: provider 검색(gpt-5-mini + 웹 검색)
 *     → 원본 주소 → 애드픽 커미션 링크 변환 (캐시 우선)
 *     → 추천 저장 (+clickId 발급)
 *     → 카카오 itemCard 캐러셀 조립 → callbackUrl 로 전송
 *
 * 호텔과 다른 점만 적어둔다.
 *
 *   · **카드가 listCard 가 아니다.** 항공권 1건은 한 줄 40자에 안 들어간다
 *     (항공사·편명·출발/도착·소요·경유·가격). itemCard 를 캐러셀로 넘긴다.
 *   · **캐시 TTL 이 짧다** (FLIGHT_CACHE_TTL_MINUTES, 기본 30분). 운임이 빨리 상한다.
 *   · **같은 sourceUrl 이 여러 편에 걸린다** (노선 검색 결과 페이지). 그래서 중복 제거는
 *     주소가 아니라 편명+시각으로 한다.
 *
 * ⚠️ **provider.search() 를 요청 경로에서 부르면 안 된다.**
 *    카카오는 5초 안에 응답을 받아야 하는데 AI 검색은 7~30초가 걸린다.
 *    캐시 미스는 전부 백그라운드로 빠진다.
 */
const DOMAIN = 'flight';

/** 빈 결과를 기억해두는 시간. 연타만 막으면 되므로 짧게 둔다. */
const EMPTY_RESULT_TTL_MS = 10 * 60_000;
const EMPTY_RESULT_MAX_ENTRIES = 500;

/** in-flight 병합·빈 결과 기억에 쓰는 키. 캐시 키와 같은 축을 쓴다. */
function searchKeyOf(provider: string, query: FlightQuery): string {
  return [provider, ...flightCacheKey(query).map((p) => p ?? '')].join(':');
}

function newClickId(): string {
  // 파이썬의 secrets.token_urlsafe(9) 와 같은 길이(12자)·문자셋.
  return randomBytes(9).toString('base64url');
}

/**
 * 같은 항공편이 캐러셀에 두 번 나가지 않게 한다.
 *
 * AI provider 는 같은 편을 표기만 바꿔 여러 번 주기도 한다 ('KE723' / 'KE 723').
 * 호텔처럼 sourceUrl 로 판정하면 안 된다 — 항공권은 여러 편이 같은 노선 검색
 * 페이지를 가리키므로 카드가 한 장만 남는다. 편명+출발시각이 항공편의 신원이다.
 */
export function dedupe(flights: Flight[], logger?: Logger): Flight[] {
  const seen = new Set<string>();
  const unique: Flight[] = [];
  for (const flight of flights) {
    const key = flightKey(flight);
    if (seen.has(key)) {
      logger?.log(`duplicate flight dropped: ${flight.airline} (${key})`);
      continue;
    }
    seen.add(key);
    unique.push(flight);
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
export class FlightService {
  private readonly logger = new Logger(FlightService.name);

  /**
   * 진행 중인 검색. 같은 노선을 동시에 물으면 OpenAI 호출이 사람 수만큼 나간다.
   * 키 하나당 검색 하나로 묶는다.
   */
  private readonly inFlight = new Map<string, Promise<Flight[]>>();

  /**
   * 방금 빈손으로 돌아온 검색 (키 → 만료 시각).
   *
   * 빈 결과는 캐시에 넣지 않는다 — 일시적 실패를 30분씩 굳히면 안 되니까.
   * 그런데 그것만 두면 없는 노선을 연타할 때마다 OpenAI 호출이 나간다.
   */
  private readonly recentlyEmpty = new Map<string, number>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FLIGHT_PROVIDER) private readonly provider: FlightProvider,
    private readonly users: UsersRepository,
    private readonly messages: MessagesRepository,
    private readonly recommendations: RecommendationsRepository,
    private readonly items: RecommendationItemsRepository,
    private readonly affiliate: AffiliateService,
    private readonly searchCache: SearchCacheService,
    private readonly nlu: FlightNluService,
    private readonly memory: MemoryStoreService,
  ) {}

  // ------------------------------------------------------------ 진입점
  async handle(payload: KakaoSkillPayload): Promise<t.Json> {
    const started = Date.now();
    const utterance = utteranceOf(payload);
    // 모델 호출이 들어간다(캐시 미스일 때만). 5초 예산의 첫 지출이라 타임아웃이 짧다.
    const parsed = await this.nlu.resolve(utterance, {
      origin: paramOf(payload, ...ORIGIN_PARAMS),
      destination: paramOf(payload, ...DEST_PARAMS),
      departDate: paramOf(payload, ...DEPART_PARAMS),
      returnDate: paramOf(payload, ...RETURN_PARAMS),
    });

    const user = await this.users.getOrCreate(userKeyOf(payload));
    const userId = (user?.id as string) ?? null;

    const message = await this.messages.log({
      userId,
      domain: DOMAIN,
      utterance,
      blockName: blockNameOf(payload),
      // 항공권에서 의미 있는 도시는 목적지다. 도메인별로 컬럼을 따로 두는 대신
      // 같은 자리에 그 도메인의 주된 도시를 넣는다 (messages.parsed_city).
      parsedCity: parsed.destSlug,
      params: actionParamsOf(payload),
      rawPayload: payload,
    });
    const messageId = (message?.id as string) ?? null;

    if (!hasRoute(parsed)) return this.askRoute();

    const query = this.queryOf(parsed);
    const ctx: RequestContext = { userId, messageId, started };

    // 5초 예산 안에서 할 수 있는 건 캐시 조회까지다.
    const cached = await this.searchCache.peek(
      DOMAIN,
      this.provider.name,
      flightCacheKey(query),
      isFlight,
    );
    if (cached.length) {
      return this.respondWithFlights(cached, query, { ...ctx, cacheHit: true });
    }

    // 방금 찾아봤는데 없었던 노선이라면 또 부르지 않는다. 오타 연타가 곧 요금이다.
    if (this.wasRecentlyEmpty(query)) {
      this.logger.log(`skipping search, recently empty route=${query.destName}`);
      return this.noResult(query);
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
      ? t.callbackAck(`${query.originName}→${query.destName} 항공권을 찾고 있어요. 잠시만요 ✈️`)
      : this.searchStarted(query);
  }

  /** 파싱 결과를 검색 쿼리로. 출발지가 없으면 기본 출발지(서울)로 채운다. */
  queryOf(parsed: ParsedFlight): FlightQuery {
    const originAssumed = !parsed.originSlug;
    return {
      originSlug: parsed.originSlug ?? this.config.flightDefaultOriginName,
      originName: parsed.originName ?? this.config.flightDefaultOriginName,
      originCode: parsed.originCode ?? (originAssumed ? this.config.flightDefaultOriginCode : null),
      destSlug: parsed.destSlug ?? '',
      destName: parsed.destName ?? '',
      destCode: parsed.destCode,
      departDate: parsed.departDate,
      returnDate: parsed.returnDate,
      tripType: parsed.tripType,
      passengers: parsed.passengers,
      cabin: parsed.cabin,
      limit: this.config.flightResultLimit,
      originAssumed,
    };
  }

  // -------------------------------------------------------- 백그라운드 검색
  /**
   * provider 를 부르고, 결과를 캐시에 넣고, 콜백으로 카드를 보낸다.
   *
   * 요청 경로 밖에서 도는 코드라 **여기서 던진 예외는 아무도 못 받는다.**
   * 전부 삼키고 로그로만 남긴다. 콜백이 있으면 실패도 사용자에게 알린다.
   */
  private async searchInBackground(
    query: FlightQuery,
    ctx: RequestContext,
    callbackUrl: string | null,
  ): Promise<void> {
    try {
      const flights = await this.searchOnce(query);
      const response = flights.length
        ? await this.respondWithFlights(flights, query, { ...ctx, cacheHit: false })
        : this.noResult(query);

      if (callbackUrl) await this.postCallback(callbackUrl, response);
    } catch (err) {
      this.logger.error(`background flight search failed dest=${query.destName} err=${err}`);
      if (!callbackUrl) return;
      await this.postCallback(
        callbackUrl,
        t.simpleText(
          `${query.destName} 항공권을 찾다가 문제가 생겼어요. 잠시 후 다시 시도해주세요 🙏`,
          this.routeQuickReplies(),
        ),
      );
    }
  }

  /** 같은 캐시 키의 검색을 하나로 묶는다. 끝나면 캐시에 저장한다. */
  private searchOnce(query: FlightQuery): Promise<Flight[]> {
    const key = searchKeyOf(this.provider.name, query);
    const running = this.inFlight.get(key);
    if (running) {
      this.logger.log(`flight search already in flight, joining key=${key}`);
      return running;
    }

    const search = (async () => {
      const flights = await this.provider.search(query);
      if (flights.length) {
        await this.searchCache.store(
          DOMAIN,
          this.provider.name,
          flightCacheKey(query),
          flights,
          // 호텔보다 짧다. 운임은 하루에도 몇 번 바뀐다.
          this.config.flightCacheTtlMinutes,
        );
      } else {
        this.rememberEmpty(key);
      }
      return flights;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, search);
    return search;
  }

  private wasRecentlyEmpty(query: FlightQuery): boolean {
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
   * 진단용 — 이미 찾아둔 항공편으로 **스킬과 똑같은 응답**을 조립한다.
   *
   * `/api/v1/debug/flight-search` 가 쓴다. 카카오 경로는 5초 예산 때문에 검색을
   * 백그라운드로 던지므로, 진짜 카드가 어떻게 생겼는지는 콜백을 받아보기 전에는 알 수 없다.
   * 여기를 거치면 **같은 조립 코드를 그대로 태워서** 미리 볼 수 있다.
   *
   * 통계는 남기지 않는다. 대신 clickId 는 인메모리에 남으므로 `/r/{clickId}` 는 동작한다.
   */
  async previewResponse(
    flights: Flight[],
    query: FlightQuery,
    opts: { started: number; links: Map<string, ResolvedLink> },
  ): Promise<t.Json> {
    if (!flights.length) return this.noResult(query);
    return this.respondWithFlights(flights, query, {
      userId: null,
      messageId: null,
      started: opts.started,
      cacheHit: false,
      persist: false,
      links: opts.links,
    });
  }

  // ------------------------------------------------------- 응답 조립
  private async respondWithFlights(
    input: Flight[],
    query: FlightQuery,
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
      /** 미리 해석해둔 제휴 링크. 주면 애드픽을 다시 부르지 않는다. */
      links?: Map<string, ResolvedLink>;
    },
  ): Promise<t.Json> {
    // 중복 제거 → 자르기 순서가 중요하다. 반대로 하면 중복이 카드 자리를 먹는다.
    const flights = dedupe(input, this.logger).slice(0, t.MAX_CAROUSEL_ITEMS);

    // 원본 주소 → 애드픽 커미션 링크. 캐시에 있으면 API 를 안 탄다.
    // 항공권은 여러 편이 같은 주소를 공유하므로 변환 호출 수가 카드 수보다 적다.
    const links =
      ctx.links ??
      (await this.affiliate.resolve(
        flights
          .filter((f) => f.sourceUrl)
          .map((f) => ({ sourceUrl: f.sourceUrl, merchant: f.merchant })),
      ));

    // persist:false 면 통계를 안 남긴다. recommendationId 가 null 이 되고,
    // 아래 items.createMany 도 자연히 건너뛴다.
    const recommendation =
      ctx.persist === false
        ? null
        : await this.recommendations.create({
            userId: ctx.userId,
            messageId: ctx.messageId,
            domain: DOMAIN,
            // 호텔의 city_slug 자리에 목적지를 넣는다. 도메인별 컬럼을 늘리지 않는다.
            citySlug: query.destSlug,
            provider: this.provider.name,
            itemCount: flights.length,
            guests: query.passengers,
            latencyMs: Date.now() - ctx.started,
            cacheHit: ctx.cacheHit,
          });
    const recommendationId = (recommendation?.id as string) ?? null;

    const rows: Record<string, unknown>[] = [];
    const cards: t.Json[] = [];
    // 두 모양을 같은 순회에서 만든다. clickId·애드픽 변환은 한 번만 돌아야 한다.
    const listItems: t.Json[] = [];
    /** 애드픽 변환이 안 돼 원본 주소로 나가는 카드. 수익화가 안 되는 노출이다. */
    const unconverted: string[] = [];

    flights.forEach((flight, position) => {
      const clickId = newClickId();
      const link = links.get(flight.sourceUrl);
      // 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 항공권을 본다.
      const destination = link?.affiliateUrl ?? flight.sourceUrl;
      if (!destination) {
        this.logger.warn(`no destination for flight=${flight.airline}, skipping card`);
        return;
      }
      // 목적지가 원본과 같다 = 커미션 링크가 아니다.
      if (destination === flight.sourceUrl) unconverted.push(flight.airline);
      const targetUrl = applySubid(destination, clickId, this.config);
      const label = itemLabel(flight);

      rows.push({
        recommendation_id: recommendationId,
        affiliate_link_id: link?.affiliateLinkId ?? null,
        position,
        click_id: clickId,
        // hotel_name 컬럼이지만 담기는 건 "노출된 항목의 이름"이다.
        // 도메인마다 컬럼을 늘리는 대신 스냅샷 자리를 공유한다 (0002 마이그레이션 주석 참고).
        hotel_name: label,
        price_from: flight.priceFrom ?? null,
        merchant: flight.merchant ?? null,
        thumbnail_url: null,
        source_url: flight.sourceUrl,
        target_url: targetUrl,
      });

      // DB가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
      this.memory.put(clickId, {
        recommendationId,
        itemName: label,
        sourceUrl: flight.sourceUrl,
        targetUrl,
        userId: ctx.userId,
      });

      const link_ = redirectUrl(this.config, clickId);
      cards.push(
        t.itemCard({
          headTitle: cardHead(flight, query),
          itemList: cardRows(flight),
          // 시각과 금액이 세로로 정렬돼야 카드끼리 비교가 된다.
          itemListAlignment: 'right',
          summary: { title: '예상가', description: priceSummary(flight, query) },
          buttons: [t.webLinkButton('예약 페이지 보기', link_)],
        }),
      );
      listItems.push(
        t.listItem({
          title: listRowTitle(flight),
          description: listRowDescription(flight),
          linkUrl: link_,
        }),
      );
    });

    if (unconverted.length) {
      // 경고로 남긴다. 배포를 막을 일은 아니지만 방치하면 그대로 매출이 샌다.
      this.logger.warn(
        `애드픽 변환 실패 ${unconverted.length}/${cards.length}건 — 원본 주소로 나간다: ` +
          unconverted.join(', '),
      );
    }

    if (!cards.length) return this.noResult(query);
    if (recommendationId) await this.items.createMany(rows);

    // ⚠️ **그룹챗봇(팀톡방)은 itemCard 를 못 그린다 — 말풍선이 통째로 사라진다.**
    //    호텔·관광지가 같은 방에서 멀쩡한 건 listCard 라서고, 그래서 기본이 list 다.
    //    앞 말풍선은 두 모양 모두에 붙인다 — 출발지를 추측했다는 사실과 가격이 확정
    //    운임이 아니라는 말이 거기 실려 있고, 둘 다 header 40자에는 안 들어간다.
    if (this.config.flightCardStyle === 'carousel') {
      return t.textThenCarousel(
        introText(query, cards.length),
        'itemCard',
        cards,
        this.routeQuickReplies(query.destSlug),
      );
    }

    return t.textThenListCard(
      introText(query, listItems.length),
      {
        headerTitle: `${query.originName}→${query.destName} 항공권 ${listItems.length}편`,
        items: listItems,
        buttons: [t.messageButton('다른 도시 보기', '항공권 추천해줘')],
      },
      this.routeQuickReplies(query.destSlug),
    );
  }

  // ------------------------------------------------------- 예외 응답
  askRoute(): t.Json {
    return t.simpleText(
      '어디로 가는 항공권을 찾으세요?\n예) 다음달 3일 오사카 왕복 항공권 2명',
      this.routeQuickReplies(),
    );
  }

  private noResult(query: FlightQuery): t.Json {
    return t.simpleText(
      `${query.originName}→${query.destName} 항공권을 찾지 못했어요.\n` +
        '도시 이름과 날짜를 다시 확인해주세요!',
      this.routeQuickReplies(),
    );
  }

  /**
   * 콜백이 꺼져 있을 때의 미스 응답.
   *
   * 검색은 이미 백그라운드에서 돌고 있다. 다시 물으면 캐시에서 바로 나간다 —
   * 콜백 없이 20초를 기다리게 할 방법이 없어서 차선책으로 둔 경로다.
   */
  private searchStarted(query: FlightQuery): t.Json {
    return t.simpleText(
      `${query.originName}→${query.destName} 항공권을 찾고 있어요 ✈️\n` +
        '30초쯤 뒤에 다시 물어봐 주세요!',
      this.routeQuickReplies(query.destSlug),
    );
  }

  routeQuickReplies(exclude?: string | null): t.Json[] {
    return CITIES.filter((c) => c.slug !== exclude).map((c) =>
      t.quickReply(`${c.nameKo} 항공권`, `${c.nameKo} 항공권 찾아줘`),
    );
  }
}

// ------------------------------------------------------------------ 카드 문구
/**
 * 카드 맨 위 줄. '인천 → 오사카 · 10/3(토)'
 *
 * 노선을 카드마다 반복하는 게 낭비처럼 보이지만, 캐러셀은 카드를 하나씩 넘겨 보기
 * 때문에 앞 말풍선을 지나친 사용자에게는 이게 유일한 맥락이다. 30자 제한이 있어
 * 날짜는 월/일까지만 쓴다.
 */
export function cardHead(flight: Flight, query: FlightQuery): string {
  const route = `${flight.originName ?? flight.originCode} → ${flight.destName ?? flight.destCode}`;
  const date = dateLabel(flight.departDate ?? query.departDate);
  return date ? `${route} · ${date}` : route;
}

/**
 * 강조되는 가격 줄.
 *
 * '1인' 을 붙이는 이유 — 2명이 물어봤을 때 이 숫자가 총액인지 1인당인지 모르면
 * 카드를 보고 예산을 짤 수 없다. provider 는 1인 총액을 준다.
 */
export function priceSummary(flight: Flight, query: FlightQuery): string {
  const price = priceText(flight);
  if (!flight.priceFrom) return price;
  return query.passengers && query.passengers > 1 ? `1인 ${price}` : price;
}

/**
 * 앞에 세우는 안내 말풍선.
 *
 * ⚠️ **가격이 확정 운임이 아니라는 말을 반드시 넣는다.** 우리는 실시간 운임 API 가
 *    없고 웹 검색으로 얻은 값을 보여준다. 이 한 줄이 없으면 사용자는 카드 가격을
 *    믿고 눌렀다가 다른 금액을 보게 된다.
 */
export function introText(query: FlightQuery, count: number): string {
  const trip = query.tripType === 'round' ? '왕복' : '편도';
  const bits = [`${query.originName}→${query.destName} ${trip} 항공권 ${count}편이에요 ✈️`];

  const conditions = [
    dateLabel(query.departDate) && `가는 날 ${dateLabel(query.departDate)}`,
    dateLabel(query.returnDate) && `오는 날 ${dateLabel(query.returnDate)}`,
    query.passengers && `${query.passengers}명`,
    query.cabin && cabinText(query.cabin),
  ].filter(Boolean);
  if (conditions.length) bits.push(conditions.join(' · '));

  // 출발지를 추측했으면 반드시 알려준다. 부산에서 출발하려던 사람이
  // 이 줄을 보고 "인천에서 출발" 을 고쳐 말할 수 있어야 한다.
  if (query.originAssumed) {
    bits.push(`${query.originName} 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.`);
  }

  bits.push('가격은 검색 시점 기준이라 실제 예약가와 다를 수 있어요.');
  return bits.join('\n');
}

/** DB·로그에 남기는 항목 이름. '대한항공 KE723 ICN→KIX' */
export function itemLabel(flight: Flight): string {
  return [
    flight.airline,
    flight.flightNo,
    `${flight.originCode}→${flight.destCode}`,
  ]
    .filter(Boolean)
    .join(' ');
}

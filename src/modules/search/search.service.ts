import { Inject, Injectable, Logger } from '@nestjs/common';

import { fetchWithTimeout } from '../../common/fetch';
import { AppConfig, CONFIG } from '../../config/app.config';
import { AttractionService } from '../attraction/attraction.service';
import { MessagesRepository } from '../database/repositories/messages.repository';
import { FlightService } from '../flight/flight.service';
import { HotelService } from '../hotel/hotel.service';
import { ParsedIntent } from '../intent/intent.types';
import * as cards from '../kakao/cards';
import * as t from '../kakao/templates';
import {
  CursorMemory,
  PAGE_SIZE,
  hasNextPage,
  moreButton,
  pageOf,
} from '../kakao/paging';
import { Place } from '../places/places.types';
import { PlacesService } from '../places/places.service';
import { SearchStoreService, isExpired } from './search-store.service';
import {
  RenderContext,
  RouterRequest,
  SearchContext,
  SearchDomain,
  SearchKind,
  SearchMeta,
  SearchRow,
  TripType,
} from './search.types';

/**
 * 검색 오케스트레이션. **라우터의 거의 전부가 여기 있다.**
 *
 *   캐시 조회 → (히트) 1페이지 즉시 반환
 *            → (미스) pending 선점 → 대기 응답 → 백그라운드 AI 검색 → 저장 → 콜백 푸시
 *
 * ⚠️ **provider 를 요청 경로에서 부르지 않는다.** 카카오는 5초 안에 응답을 받아야
 *    하는데 AI 검색은 7~30초다. 요청 경로에서 도는 건 저장소 조회까지다.
 *
 * **도메인을 모른다.** 호텔이 오는지 항공권이 오는지는 [SearchDomain](./search.types.ts)
 * 구현이 알고, 여기는 캐시 키·페이지·고지·콜백만 다룬다. 네 번째 도메인이 생겨도
 * 이 파일은 그대로다.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly domains = new Map<SearchKind, SearchDomain>();
  /** `action:"block"` 이 안 될 때를 위한 발화자별 커서. */
  private readonly cursors = new CursorMemory();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly store: SearchStoreService,
    private readonly places: PlacesService,
    private readonly messages: MessagesRepository,
    hotels: HotelService,
    flights: FlightService,
    attractions: AttractionService,
  ) {
    for (const domain of [hotels, flights, attractions] as SearchDomain[]) {
      this.domains.set(domain.kind, domain);
    }
  }

  // ------------------------------------------------------------ 진입점
  /**
   * 새 검색 요청. 캐시에 있으면 즉시, 없으면 백그라운드로 넘긴다.
   */
  async serve(parsed: ParsedIntent, place: Place, req: RouterRequest): Promise<t.Json> {
    const kind = parsed.intent as SearchKind;
    const parent = await this.places.parentOf(place);
    const from = kind === 'flight' ? await this.origin(parsed.from) : null;

    const meta: SearchMeta = {
      kind,
      placeName: place.canonicalName,
      placeSlug: place.slug,
      fromName: from?.canonicalName ?? null,
      tripType: kind === 'flight' ? parsed.tripType : null,
      originAssumed: kind === 'flight' ? !parsed.from : false,
    };
    const cacheKey = cacheKeyOf(kind, place, from, parsed.tripType);
    const messageId = await this.logMessage(req, kind, place.slug);

    const row = await this.store.get(cacheKey);

    // 저장된 결과가 있다 — 만료됐어도 그대로 보여주고 **뒤에서 조용히 새로 찾는다.**
    // 사용자에게 "예전 정보" 라고 알리지 않는다: 할 수 있는 일이 없는 사정이고,
    // 다음 질문에는 새 결과가 나간다.
    //
    // ⚠️ **관광지만 예외다.** 그 행에는 구글 콘텐츠(이름·평점)가 들어 있고, 구글 약관은
    //    place_id 외의 콘텐츠를 오래 보관하는 걸 제한한다. 그래서 만료된 관광지 값은
    //    보여주지 않고 다시 찾는다 — 잃는 것도 없다. 목록(place_id)은
    //    attraction_places 에 영구로 남아 있어 다시 물으면 채워진다.
    const stale = row ? isExpired(row) : false;
    const usable = row && row.items.length && row.status !== 'pending' && !(stale && kind === 'attraction');
    if (usable) {
      if (stale) void this.refresh(parsed, place, parent, from, meta, cacheKey, row, req);
      this.logger.log(`cache ${stale ? 'stale' : 'hit'} key=${cacheKey} items=${row.items.length}`);
      return this.respond(row.items, meta, 0, cacheKey, req, {
        ignored: parsed.ignored,
        messageId,
        cacheHit: true,
      });
    }

    // 누군가 이미 같은 걸 찾고 있다. AI 를 한 번 더 부르지 않는다.
    if (row && this.store.isBusy(row)) return cards.busyText(meta);

    // ⚠️ 검색을 할 수 없는 상태면 **여기서 끊는다.** 선점도, 대기 응답도 만들지 않는다.
    //    "30초쯤 뒤에 다시 물어봐 주세요" 는 결과가 영원히 안 오는데 기다리게 하는
    //    거짓말이고, 실패 행을 남기면 키를 꽂은 뒤에도 TTL 동안 안 찾는다.
    if (!this.domainOf(kind).ready) {
      this.logger.error(
        `${kind} 검색 불가 — provider 에 키가 없다. /health 의 openai 필드를 확인하라.`,
      );
      return cards.unavailableText(meta);
    }

    // 방금 실패했거나 빈손이었다. 짧은 TTL 이 지나면 다시 찾아본다.
    if (row?.status === 'failed' && !isExpired(row)) return cards.emptyText(meta);

    const claimed = await this.store.claim(
      {
        cacheKey,
        kind,
        placeId: place.id,
        fromPlaceId: from?.id ?? null,
        toPlaceId: kind === 'flight' ? place.id : null,
        tripType: kind === 'flight' ? parsed.tripType : null,
        meta,
      },
      row,
    );
    if (!claimed) return cards.busyText(meta);

    const ctx: SearchContext = {
      kind,
      place,
      parent,
      from,
      tripType: parsed.tripType,
      limit: this.config.resultMaxItems,
    };
    void this.runSearch(ctx, meta, cacheKey, row, req, { ignored: parsed.ignored, messageId });

    if (!req.callbackUrl) {
      // ⚠️ 콜백은 오픈빌더에서 그 블록의 [콜백 사용] 을 켠 경우에만 실린다. 꺼져 있으면
      //    사용자는 같은 질문을 두 번 해야 한다 — 서버가 아니라 설정 문제이므로 남긴다.
      this.logger.warn('callbackUrl 없음 — 오픈빌더에서 폴백 블록의 [콜백 사용] 이 꺼져 있다');
      return cards.searchStartedText(meta);
    }
    return t.callbackAck(`${cards.withObjectParticle(cards.subject(meta))} 찾고 있어요. 잠시만요 🔍`);
  }

  /**
   * **배치가 캐시를 미리 채운다.** 요청 경로와 같은 키·같은 저장소를 쓴다.
   *
   * 미리 채워두면 그 도시의 첫 질문부터 카드가 즉시 나간다 — 지금은 "찾고 있어요" 를
   * 보내고 콜백을 기다려야 한다. 배치용 파이프라인을 따로 만들지 않는 이유는 진단
   * 컨트롤러와 같다: 따로 만들면 실제 응답을 데우는 게 아니라 비슷한 걸 하나 더
   * 만드는 것이다.
   *
   * ⚠️ **선점을 거쳐 간다.** 마침 사용자가 같은 도시를 물어 검색이 돌고 있으면 배치는
   *    물러난다. 같은 도시를 두 번 찾으면 그만큼 API 요금이다.
   */
  async warm(kind: SearchKind, place: Place): Promise<unknown[]> {
    const cacheKey = cacheKeyOf(kind, place, null, 'rt');
    const row = await this.store.get(cacheKey);
    if (row && this.store.isBusy(row)) return [];

    const meta: SearchMeta = {
      kind,
      placeName: place.canonicalName,
      placeSlug: place.slug,
    };
    const claimed = await this.store.claim(
      {
        cacheKey,
        kind,
        placeId: place.id,
        fromPlaceId: null,
        toPlaceId: null,
        tripType: null,
        meta,
      },
      row,
    );
    if (!claimed) return [];

    try {
      const items = await this.domainOf(kind).search({
        kind,
        place,
        parent: await this.places.parentOf(place),
        from: null,
        tripType: 'rt',
        limit: this.config.resultMaxItems,
      });
      if (!items.length) {
        // 빈손을 캐시로 굳히지 않는다. 짧은 TTL 이면 다음 배치가 다시 집는다.
        await this.store.fail(cacheKey, 'empty result', 1, meta);
        return [];
      }
      await this.store.complete(cacheKey, items, this.ttlOf(kind), meta);
      return items;
    } catch (err) {
      await this.store.fail(cacheKey, String(err), this.config.failedTtlMinutes, meta);
      throw err;
    }
  }
  /**
   * "더 보기". **AI 를 부르지 않는다** — 저장된 행에서 offset 만큼 잘라 보낸다.
   */
  async servePage(cacheKey: string, offset: number, req: RouterRequest): Promise<t.Json> {
    const row = await this.store.get(cacheKey);
    if (!row || !row.items.length) {
      this.logger.log(`more requested but nothing stored key=${cacheKey}`);
      return cards.helpCard();
    }
    return this.respond(row.items, row.meta, offset, cacheKey, req, {
      ignored: [],
      messageId: null,
      cacheHit: true,
    });
  }

  /** 메시지 버튼 경로에서 쓰는 발화자별 커서. */
  cursorOf(userKey: string): { cacheKey: string; offset: number } | null {
    return this.cursors.take(userKey);
  }

  /** 테스트·운영 점검용. */
  clearMemory(): void {
    this.store.clearMemory();
    this.cursors.clear();
  }

  // -------------------------------------------------------- 백그라운드
  /**
   * provider 를 부르고, 결과를 저장하고, 콜백으로 카드를 보낸다.
   *
   * 요청 경로 밖에서 도는 코드라 **여기서 던진 예외는 아무도 못 받는다.**
   * 전부 삼키고 로그로만 남긴다. 선점한 행은 어떤 경로로든 반드시 풀어준다 —
   * 안 그러면 그 지역은 pending 이 만료될 때까지 아무도 검색하지 못한다.
   */
  private async runSearch(
    ctx: SearchContext,
    meta: SearchMeta,
    cacheKey: string,
    previous: SearchRow | null,
    req: RouterRequest,
    opts: { ignored: string[]; messageId: string | null },
  ): Promise<void> {
    const domain = this.domainOf(meta.kind);
    try {
      const items = await domain.search(ctx);

      if (!items.length) {
        // ⚠️ **한 번의 빈손으로 굳히지 않는다.** 모델은 같은 질의에도 가끔 빈손으로
        //    돌아온다. 한 번에 10분을 굳히면 그게 그대로 10분짜리 장애가 된다
        //    ("도쿄 호텔" 이 실제로 그랬다). 연속 두 번이면 진짜 없는 것으로 본다.
        const streak = (previous?.meta?.emptyStreak ?? 0) + 1;
        const ttl = streak >= 2 ? this.config.failedTtlMinutes : 1;
        await this.store.fail(cacheKey, 'empty result', ttl, { ...meta, emptyStreak: streak });
        this.logger.warn(`search empty key=${cacheKey} streak=${streak} ttl=${ttl}m`);
        await this.push(req, cards.emptyText(meta));
        return;
      }

      await this.store.complete(cacheKey, items, this.ttlOf(meta.kind), meta);
      this.logger.log(`search stored key=${cacheKey} items=${items.length}`);

      const response = await this.respond(items, meta, 0, cacheKey, req, {
        ignored: opts.ignored,
        messageId: opts.messageId,
        cacheHit: false,
      });
      await this.push(req, response);
    } catch (err) {
      this.logger.error(`background search failed key=${cacheKey} err=${err}`);
      await this.store.fail(cacheKey, String(err), this.config.failedTtlMinutes, meta);
      await this.push(req, cards.failedText(meta));
    }
  }

  /**
   * 만료된 결과를 조용히 새로 고친다.
   *
   * 사용자는 이미 예전 결과를 받았다. 여기서 실패해도 알릴 필요가 없다 —
   * 그래서 콜백을 쓰지 않는다.
   */
  private async refresh(
    parsed: ParsedIntent,
    place: Place,
    parent: Place | null,
    from: Place | null,
    meta: SearchMeta,
    cacheKey: string,
    row: SearchRow,
    req: RouterRequest,
  ): Promise<void> {
    const claimed = await this.store.claim(
      {
        cacheKey,
        kind: meta.kind,
        placeId: place.id,
        fromPlaceId: from?.id ?? null,
        toPlaceId: meta.kind === 'flight' ? place.id : null,
        tripType: meta.tripType ?? null,
        meta,
      },
      row,
    );
    if (!claimed) return;

    await this.runSearch(
      { kind: meta.kind, place, parent, from, tripType: parsed.tripType, limit: this.config.resultMaxItems },
      meta,
      cacheKey,
      row,
      { ...req, callbackUrl: null },
      { ignored: parsed.ignored, messageId: null },
    );
  }

  // ------------------------------------------------------- 응답 조립
  private async respond(
    items: unknown[],
    meta: SearchMeta,
    offset: number,
    cacheKey: string,
    req: RouterRequest,
    opts: {
      ignored: string[];
      messageId: string | null;
      cacheHit: boolean;
    },
  ): Promise<t.Json> {
    const domain = this.domainOf(meta.kind);
    // 저장 당시와 필드가 달라졌을 수 있다(배포 직후). 모양이 안 맞는 항목은 버린다.
    const valid = items.filter((item) => domain.isItem(item));
    const { page, start } = pageOf(valid, offset, this.config.resultMaxItems);
    if (!page.length) return cards.emptyText(meta);

    const render: RenderContext = {
      meta,
      userId: req.userId,
      messageId: opts.messageId,
      started: req.started,
      cacheHit: opts.cacheHit,
    };
    const rows = await domain.rows(page, render);
    if (!rows.length) return cards.emptyText(meta);

    const buttons: t.Json[] = [];
    if (hasNextPage(valid.length, start, this.config.resultMaxItems)) {
      const nextOffset = start + PAGE_SIZE;
      buttons.push(
        moreButton({
          style: this.config.moreButtonStyle,
          blockId: this.config.fallbackBlockId || req.blockId,
          messageText: domain.moreText(meta),
          cacheKey,
          nextOffset,
        }),
      );
      // 메시지 버튼은 커서를 못 싣는다. 그때는 서버가 이 사람의 다음 페이지를 기억한다.
      if (this.config.moreButtonStyle === 'message') {
        this.cursors.remember(req.userKey, { cacheKey, offset: nextOffset });
      }
    }

    return t.listCardWithNotice(
      {
        headerTitle: domain.headerTitle(meta, rows.length, start),
        items: rows,
        buttons,
      },
      cards.noticeText({ ignored: opts.ignored, meta }),
      domain.quickReplies(meta),
    );
  }

  /**
   * 완성된 응답을 카카오 콜백 주소로 보낸다.
   *
   * 카카오는 이 POST 를 1분 안에 받아야 하고, 본문은 평소 스킬 응답과 같은 형식이다.
   * 실패해도 되돌릴 방법이 없으므로 로그만 남긴다.
   *
   * ⚠️ 그룹챗봇이 콜백 푸시를 실제로 받는지 **검증되지 않았다.** 팀톡방에서 확인 후
   *    안 되면 콜백을 아예 끄고 "잠시 뒤 다시 물어봐 주세요" 로 통일해야 한다.
   */
  private async push(req: RouterRequest, body: t.Json): Promise<void> {
    if (!req.callbackUrl) return;

    try {
      await fetchWithTimeout(
        req.callbackUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        this.config.kakaoCallbackTimeoutMs,
        async (res) => {
          if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 200);
            this.logger.warn(`kakao callback rejected status=${res.status} body=${detail}`);
            return;
          }
          this.logger.log('kakao callback delivered');
        },
      );
    } catch (err) {
      this.logger.warn(`kakao callback failed err=${err}`);
    }
  }

  // ------------------------------------------------------------- 잡동사니
  private domainOf(kind: SearchKind): SearchDomain {
    const domain = this.domains.get(kind);
    if (!domain) throw new Error(`no search domain for kind=${kind}`);
    return domain;
  }

  private ttlOf(kind: SearchKind): number {
    if (kind === 'flight') return this.config.flightCacheTtlMinutes;
    if (kind === 'attraction') return this.config.attractionCacheTtlMinutes;
    return this.config.hotelCacheTtlMinutes;
  }

  /** 항공권 출발지. 말하지 않았으면 서울로 채우고, 채웠다는 사실을 카드에 적는다. */
  private async origin(from: string | null): Promise<Place | null> {
    return this.places.resolve(from ?? this.config.flightDefaultOriginName);
  }

  private async logMessage(
    req: RouterRequest,
    kind: SearchKind,
    placeSlug: string | null,
  ): Promise<string | null> {
    const message = await this.messages.log({
      userId: req.userId,
      domain: kind,
      utterance: req.utterance,
      blockName: null,
      parsedCity: placeSlug,
      params: {},
      rawPayload: null,
    });
    return (message?.id as string) ?? null;
  }
}

/**
 * 캐시 키.
 *
 * ⚠️ **항공권은 출발지·도착지·왕복여부가 모두 들어가야 한다.** 지역만으로 잡으면
 *    왕복을 물은 사람에게 편도 결과가 나간다.
 * ⚠️ **날짜·인원은 넣지 않는다.** 넣으면 캐시가 거의 안 맞아 매 질문이 AI 호출이 된다.
 *    대신 반영하지 않았다는 사실을 카드 아래에 반드시 적는다 (cards.noticeText).
 */
export function cacheKeyOf(
  kind: SearchKind,
  place: Place,
  from: Place | null,
  tripType: TripType,
): string {
  if (kind === 'flight') return `flight:${from?.id ?? 0}>${place.id}:${tripType}`;
  return `${kind}:${place.id}`;
}

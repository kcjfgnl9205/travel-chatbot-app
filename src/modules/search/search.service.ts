import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { fetchWithTimeout } from '../../common/fetch';
import { AppConfig, CONFIG } from '../../config/app.config';
import { AttractionService } from '../attraction/attraction.service';
import { MessagesRepository } from '../database/repositories/messages.repository';
import { FlightService } from '../flight/flight.service';
import { parseTripParams, withoutUsed } from '../flight/trip-params';
import { HotelService } from '../hotel/hotel.service';
import { ParsedIntent } from '../intent/intent.types';
import * as cards from '../kakao/cards';
import { isCredentialError } from '../openai/openai.service';
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
import { adpickCarries } from '../adpick/adpick.service';
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
 * 경로가 둘이다. `domain.peek()` 이 즉시 답하느냐로 갈린다.
 *
 *   즉시 경로 (관광지 — DB 에 목록이 있을 때)
 *     peek → 저장 → 1페이지 즉시 반환
 *
 *   느린 경로 (호텔·항공권 · 관광지의 빈 도시)
 *     캐시 조회 → (히트) 1페이지 즉시 반환
 *              → (미스) pending 선점 → 대기 응답 → 백그라운드 AI → 저장 → 콜백 푸시
 *
 * ⚠️ **느린 경로는 provider 를 요청 경로에서 부르지 않는다.** 카카오는 5초 안에
 *    응답을 받아야 하는데 AI 검색은 7~30초다. 거기서 도는 건 저장소 조회까지다.
 *    `peek` 은 DB 쿼리 하나라 그 제약이 없다 (0009).
 *
 * **도메인을 모른다.** 호텔이 오는지 항공권이 오는지는 [SearchDomain](./search.types.ts)
 * 구현이 알고, 여기는 캐시 키·페이지·고지·콜백만 다룬다. 네 번째 도메인이 생겨도
 * 이 파일은 그대로다.
 */
/**
 * 쓰고 있는 중인 메시지 행. id 는 먼저 정해지고 쓰기는 뒤따른다.
 * 노출 기록이 FK 때문에 `write` 를 기다려야 한다.
 */
interface PendingMessage {
  id: string | null;
  write: Promise<unknown>;
}

/** 메시지를 남기지 않는 경로(백그라운드 재검색·진단)가 쓴다. */
const NO_MESSAGE: PendingMessage = { id: null, write: Promise.resolve(null) };

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
      // 빈손 안내가 이걸로 갈린다 — 세부 지역을 말한 사람에게 "동네를 붙여 말하라" 고
      // 하면 안 된다 ([cards.ts](../kakao/cards.ts) narrowerHint).
      placeKind: place.kind,
      fromName: from?.canonicalName ?? null,
      tripType: kind === 'flight' ? parsed.tripType : null,
      originAssumed: kind === 'flight' ? !parsed.from : false,
    };
    const cacheKey = cacheKeyOf(kind, place, from, parsed.tripType);
    const message = this.logMessage(req, kind, place.slug);
    const domain = this.domainOf(kind);

    // ⚠️ **고칠 수 없는 날짜는 링크를 만들기 전에 되묻는다.** 지난 날짜거나 귀국일이
    //    출발일보다 빠른데, 둘 다 사용자가 직접 적은 경우다. 예전에는 조용히 고쳐서
    //    **말한 적 없는 날짜로 검색된 링크**를 줬다 — 11월 20일 귀국이 11월 30일로,
    //    2026년이 2027년으로 바뀌었고 안내에는 연도를 안 찍어 드러나지도 않았다.
    //
    //    검색을 시작하기 전에 끊는 게 중요하다. 항공권은 캐시가 노선 단위라 날짜가
    //    틀려도 캐시는 멀쩡히 채워지고, 그러면 다음 사람이 그 행을 받는다.
    const asked = kind === 'flight' ? parseTripParams(req.utterance, new Date(req.started)) : null;
    if (asked?.problem) {
      this.logger.log(
        `date problem kind=${asked.problem.kind} utterance=${JSON.stringify(req.utterance)}`,
      );
      return cards.fixDatesCard(meta, asked, req.botName);
    }

    // ⚠️ **즉시 답할 수 있으면 캐시도 선점도 거치지 않는다** (관광지).
    //
    //    캐시는 비싼 호출을 아끼려고 있는 것인데, DB 목록이 있으면 인덱스 하나 타는
    //    쿼리라 아낄 것이 없다. 오히려 캐시를 두면 관리 화면에서 방금 고친 것이 TTL
    //    동안 안 보이고, 운영자는 "저장이 안 됐나" 를 의심한다.
    //
    //    null 이 오면 즉시 못 정한다는 뜻이라 아래 느린 경로로 흘러간다
    //    (빈 도시 → 모델이 채워야 하고, 그건 7~30초다).
    if (domain.peek && domain.ready) {
      // ⚠️ **터져도 여기서 멈추지 않는다.** 던지게 두면 라우터의 일반 오류 처리로
      //    새서 "일시적인 문제" 같은 뭉뚱그린 말풍선이 나간다. DB 가 1초 흔들린
      //    것뿐일 수 있으므로 아래 느린 경로로 흘려보낸다 — 거기에는 캐시도 있고
      //    도메인별 실패 문구도 있다.
      const instant = await domain
        .peek(ctx(kind, place, parent, from, parsed, this.config))
        .catch((err) => {
          this.logger.warn(`peek failed key=${cacheKey} err=${err}`);
          return null;
        });
      if (instant) {
        if (!instant.length) return await this.emptyResponse(meta, req);
        await this.store.complete(cacheKey, instant, this.ttlOf(kind), meta);
        this.logger.log(`instant key=${cacheKey} items=${instant.length}`);
        return this.respond(instant, meta, 0, cacheKey, req, {
          ignored: parsed.ignored,
          message,
          cacheHit: false,
        });
      }
    }

    const row = await this.store.get(cacheKey);

    // 저장된 결과가 있다 — 만료됐어도 그대로 보여주고 **뒤에서 조용히 새로 찾는다.**
    // 사용자에게 "예전 정보" 라고 알리지 않는다: 할 수 있는 일이 없는 사정이고,
    // 다음 질문에는 새 결과가 나간다.
    //
    // 0008 에는 관광지 예외가 있었다 — 그 행에 구글 콘텐츠가 들어 있어서 약관상
    // 만료되면 보여주면 안 됐다. 0009 에서 관광지가 즉시 도메인이 되면서 여기까지
    // 내려오지 않으므로 예외도 같이 사라졌다.
    const stale = row ? isExpired(row) : false;
    const usable = row && row.items.length && row.status !== 'pending';
    if (usable) {
      if (stale) void this.refresh(parsed, place, parent, from, meta, cacheKey, row, req);
      this.logger.log(`cache ${stale ? 'stale' : 'hit'} key=${cacheKey} items=${row.items.length}`);
      return this.respond(row.items, meta, 0, cacheKey, req, {
        ignored: parsed.ignored,
        message,
        cacheHit: true,
      });
    }

    // 누군가 이미 같은 걸 찾고 있다. AI 를 한 번 더 부르지 않는다.
    if (row && this.store.isBusy(row)) return cards.busyText(meta, req.botName);

    // ⚠️ 검색을 할 수 없는 상태면 **여기서 끊는다.** 선점도, 대기 응답도 만들지 않는다.
    //    "30초쯤 뒤에 다시 물어봐 주세요" 는 결과가 영원히 안 오는데 기다리게 하는
    //    거짓말이고, 실패 행을 남기면 키를 꽂은 뒤에도 TTL 동안 안 찾는다.
    if (!this.domainOf(kind).ready) {
      this.logger.error(
        `${kind} 검색 불가 — provider 에 키가 없다. /health 의 openai 필드를 확인하라.`,
      );
      return cards.unavailableText(meta, req.botName);
    }

    // 방금 실패했거나 빈손이었다. 짧은 TTL 이 지나면 다시 찾아본다.
    if (row?.status === 'failed' && !isExpired(row)) return await this.emptyResponse(meta, req);

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
    if (!claimed) return cards.busyText(meta, req.botName);

    void this.runSearch(
      ctx(kind, place, parent, from, parsed, this.config),
      meta,
      cacheKey,
      row,
      req,
      { ignored: parsed.ignored, message },
    );

    if (!req.callbackUrl) {
      // ⚠️ 콜백은 오픈빌더에서 그 블록의 [콜백 사용] 을 켠 경우에만 실린다. 꺼져 있으면
      //    사용자는 같은 질문을 두 번 해야 한다 — 서버가 아니라 설정 문제이므로 남긴다.
      this.logger.warn('callbackUrl 없음 — 오픈빌더에서 폴백 블록의 [콜백 사용] 이 꺼져 있다');
      return cards.searchStartedText(meta, req.botName);
    }
    return t.callbackAck(`${cards.withObjectParticle(cards.subject(meta))} 찾고 있어요. 잠시만요 🔍`);
  }

  /**
   * "더 보기". **AI 를 부르지 않는다** — 저장된 행에서 offset 만큼 잘라 보낸다.
   */
  async servePage(cacheKey: string, offset: number, req: RouterRequest): Promise<t.Json> {
    const row = await this.store.get(cacheKey);
    if (!row || !row.items.length) {
      this.logger.log(`more requested but nothing stored key=${cacheKey}`);
      return cards.helpCard(req.botName);
    }
    return this.respond(row.items, row.meta, offset, cacheKey, req, {
      ignored: [],
      message: NO_MESSAGE,
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
   *
   * ⚠️ **전체 시간을 여기서 끊는다.** 모델 호출마다 걸린 60초로는 못 막는다 —
   *    2단 호출 + 썸네일이면 합이 콜백 URL 수명(5분)을 넘길 수 있고, 그러면 URL 이
   *    만료돼 사용자는 "찾고 있어요" 만 보고 끝난다. **침묵보다 실패 카드가 낫다.**
   */
  private async runSearch(
    ctx: SearchContext,
    meta: SearchMeta,
    cacheKey: string,
    previous: SearchRow | null,
    req: RouterRequest,
    opts: { ignored: string[]; message: PendingMessage },
  ): Promise<void> {
    const domain = this.domainOf(meta.kind);

    // ⚠️ **콜백 URL 은 1회만 유효하다.** 타임아웃 푸시와 늦게 끝난 검색의 푸시가
    //    겹치면 둘 중 하나는 버려지는데, 어느 쪽이 버려질지는 운이다. 한 번만 보낸다.
    let pushed = false;
    const pushOnce = async (body: t.Json): Promise<void> => {
      if (pushed) return;
      pushed = true;
      await this.push(req, body);
    };

    // 검색은 멈출 방법이 없다(모델 호출 중이다). 기다리기를 그만둘 뿐이다.
    const search = domain.search(ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.config.searchTimeoutMs);
    });

    try {
      const items = await Promise.race([search, timeout]);

      if (items === null) {
        this.logger.error(
          `search timed out key=${cacheKey} after=${this.config.searchTimeoutMs}ms — ` +
            '실패 카드를 보낸다. 콜백 URL 을 그냥 태우면 사용자는 아무것도 못 받는다.',
        );
        await this.store.fail(cacheKey, 'timeout', this.config.failedTtlMinutes, meta);
        await pushOnce(cards.failedText(meta, req.botName));
        this.storeLate(search, cacheKey, meta);
        return;
      }

      if (!items.length) {
        // ⚠️ **한 번의 빈손으로 굳히지 않는다.** 모델은 같은 질의에도 가끔 빈손으로
        //    돌아온다. 한 번에 10분을 굳히면 그게 그대로 10분짜리 장애가 된다
        //    ("도쿄 호텔" 이 실제로 그랬다). 연속 두 번이면 진짜 없는 것으로 본다.
        const streak = (previous?.meta?.emptyStreak ?? 0) + 1;
        const ttl = streak >= 2 ? this.config.failedTtlMinutes : 1;
        await this.store.fail(cacheKey, 'empty result', ttl, { ...meta, emptyStreak: streak });
        this.logger.warn(`search empty key=${cacheKey} streak=${streak} ttl=${ttl}m`);
        await pushOnce(await this.emptyResponse(meta, req));
        return;
      }

      await this.store.complete(cacheKey, items, this.ttlOf(meta.kind), meta);
      this.logger.log(`search stored key=${cacheKey} items=${items.length}`);

      const response = await this.respond(items, meta, 0, cacheKey, req, {
        ignored: opts.ignored,
        message: opts.message,
        cacheHit: false,
      });
      await pushOnce(response);
    } catch (err) {
      this.logger.error(`background search failed key=${cacheKey} err=${err}`);
      await this.store.fail(cacheKey, String(err), this.config.failedTtlMinutes, meta);
      // ⚠️ **자격증명이 거부된 것이면 "잠시 뒤 다시" 는 거짓말이다.** 키를 고치기 전에는
      //    몇 번을 물어도 같은 결과고, 사용자는 그 사이 같은 질문만 반복한다.
      //    다음 요청부터는 ready 가 false 라 여기까지 오지도 않는다 — 이 한 번은
      //    이미 기다린 사람의 몫이라 여기서 가른다.
      await pushOnce(
        isCredentialError(err)
          ? cards.unavailableText(meta, req.botName)
          : cards.failedText(meta, req.botName),
      );
    } finally {
      // 검색이 이겼으면 타이머가 남는다. 안 치우면 그만큼 프로세스가 안 죽는다.
      clearTimeout(timer);
    }
  }

  /**
   * 타임아웃 뒤에 끝난 검색을 **저장만** 한다.
   *
   * 버리기는 아깝다 — 돈과 시간을 이미 썼고, 사용자가 다시 물으면 그 결과가 바로
   * 나간다. 하지만 **푸시는 못 한다.** 콜백 URL 은 1회용이고 실패 카드에 이미 썼다.
   */
  private storeLate(search: Promise<unknown[]>, cacheKey: string, meta: SearchMeta): void {
    void search
      .then(async (items) => {
        if (!items.length) return;
        await this.store.complete(cacheKey, items, this.ttlOf(meta.kind), meta);
        this.logger.log(`late search stored key=${cacheKey} items=${items.length}`);
      })
      .catch((err) => this.logger.warn(`late search discarded key=${cacheKey} err=${err}`));
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
      { ignored: parsed.ignored, message: NO_MESSAGE },
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
      message: PendingMessage;
      cacheHit: boolean;
    },
  ): Promise<t.Json> {
    const domain = this.domainOf(meta.kind);
    // 저장 당시와 필드가 달라졌을 수 있다(배포 직후). 모양이 안 맞는 항목은 버린다.
    const valid = items.filter((item) => domain.isItem(item));
    const { page, start } = pageOf(valid, offset, this.config.resultMaxItems);
    if (!page.length) return await this.emptyResponse(meta, req);

    // ⚠️ **날짜·인원은 여기서 발화에서 읽는다. 행에서 읽지 않는다.**
    //    행은 모두가 공유하고 6시간 산다 — A 가 말한 10월 20일을 저장해두면 B 의
    //    링크가 그 날짜로 열린다. 카드를 그리는 순간 그 사람의 말에서 다시 읽으면
    //    그런 일이 없다 (링크 날짜를 저장하지 않는 것과 같은 이유다, 0004).
    //
    //    "더 보기" 경로의 발화는 버튼이 보낸 문장이라 날짜가 없다. 그때는 기본값으로
    //    열린다 — 링크 카드는 줄이 셋뿐이라 다음 페이지가 없으므로 실제로는 안 걸린다.
    const trip = meta.kind === 'flight' ? parseTripParams(req.utterance, new Date(req.started)) : null;

    const render: RenderContext = {
      meta,
      userId: req.userId,
      messageId: opts.message.id,
      messageWrite: opts.message.write,
      started: req.started,
      cacheHit: opts.cacheHit,
      trip,
    };
    const rows = await domain.rows(page, render);
    if (!rows.length) return await this.emptyResponse(meta, req);

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
    // ⚠️ **"더 보기" 다음에 넣어야 한다.** listCard 버튼은 2개가 한계이고
    //    listCardWithNotice 가 slice(0, 2) 로 조용히 자른다. 순서를 뒤집으면 넘칠 때
    //    페이지 넘김이 사라지는데, 공유보다 그쪽이 훨씬 중요하다.
    buttons.push(t.shareButton());

    return t.listCardWithNotice(
      {
        headerTitle: domain.headerTitle(meta, rows.length, start),
        items: rows,
        buttons,
      },
      // ⚠️ **반영한 조건은 고지에서 뺀다.** 날짜를 링크에 넣어놓고 "날짜는 반영되지
      //    않았어요" 라고 적으면, 사용자는 맞는 링크를 받고도 틀렸다고 읽는다.
      cards.noticeText({
        ignored: trip ? withoutUsed(opts.ignored, trip.used) : opts.ignored,
        meta,
        trip,
        now: new Date(req.started),
        affiliate: carriesAffiliate(meta.kind, page),
      }),
      req.botName,
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
    return this.pushCallback(req.callbackUrl, body);
  }

  /**
   * 콜백 주소로 응답 하나를 민다. **라우터도 쓴다.**
   *
   * 라우터가 응답 예산을 넘겨 `useCallback` 으로 끊은 경우, 늦게 끝난 답을 여기로
   * 보낸다([router.controller.ts](../kakao/router.controller.ts) `pushWhenReady`).
   * 검색 쪽 `push` 와 같은 코드를 타야 재시도·로그가 한 곳에 남는다.
   *
   * ⚠️ **콜백 URL 은 1회만 유효하다.** 두 번 쏘면 둘 중 하나는 버려지고 어느 쪽이
   *    버려질지는 운이다. 부르는 쪽이 한 번만 부르도록 책임진다.
   */
  async pushCallback(callbackUrl: string | null, body: t.Json): Promise<void> {
    if (!callbackUrl) return;

    try {
      await fetchWithTimeout(
        callbackUrl,
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

  /**
   * **빈손 응답.** 도메인이 대신 내놓을 줄이 있으면 그걸 쓰고, 없으면 평소 문구다.
   *
   * 호텔만 줄을 갖는다 — AI 가 빈손이어도 "그 지역 호텔 검색 결과" 는 우리가
   * 모델 없이 열어줄 수 있기 때문이다([hotel.service.ts](../hotel/hotel.service.ts)
   * `emptyRows`). "정리하지 못했어요" 는 막다른 길이라, 같은 말을 반복하는 사용자가
   * 같은 문구만 받는다.
   *
   * ⚠️ **줄을 캐시에 저장하지 않는다.** 저장하면 그 지역은 TTL 동안 AI 검색을 다시
   *    안 하고 영영 링크 두 줄만 나간다. 빈손은 빈손으로 기록하고 화면만 채운다.
   *
   * ⚠️ **여기서 터지면 안 된다.** 빈손을 알리러 온 길에서 예외가 나면 사용자는
   *    원인 불명 오류를 받는다. 실패하면 평소 문구로 떨어진다.
   */
  private async emptyResponse(meta: SearchMeta, req: RouterRequest): Promise<t.Json> {
    const domain = this.domains.get(meta.kind);
    if (!domain?.emptyRows) return cards.emptyText(meta, req.botName);

    const render: RenderContext = {
      meta,
      userId: req.userId,
      messageId: null,
      started: req.started,
      cacheHit: false,
      // 날짜·인원은 **그 사람의 발화**에서 읽는다. 행에서 읽으면 남이 말한 날짜가 묻어난다.
      trip: parseTripParams(req.utterance, new Date(req.started)),
    };

    const rows = await domain.emptyRows(meta, render).catch((err) => {
      this.logger.warn(`emptyRows failed kind=${meta.kind} err=${err}`);
      return [] as t.Json[];
    });
    if (!rows.length) return cards.emptyText(meta, req.botName);

    this.logger.log(`empty fallback kind=${meta.kind} place=${meta.placeName} rows=${rows.length}`);
    return t.listCardWithNotice(
      {
        headerTitle: cards.emptyFallbackHeader(meta),
        items: rows,
        buttons: [t.shareButton()],
      },
      // ⚠️ 왜 추천이 아니라 검색 링크인지 반드시 말한다. 안 그러면 추천 품질이
      //    갑자기 나빠진 것처럼 보인다. 제휴 고지는 이 줄들도 제휴를 타므로 같이.
      [cards.EMPTY_FALLBACK_NOTICE, cards.AFFILIATE_NOTICE].join('\n'),
      req.botName,
    );
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

  /**
   * 발화를 기록한다. **기다리지 않는다.**
   *
   * ⚠️ 예전에는 `await` 해서 id 를 받아왔다. 분석용 insert 한 건을 카카오 3.5초
   *    예산 안에서 기다린 것인데, Supabase 왕복이 약 50ms 라 그만큼이 매 요청에
   *    그대로 붙었다. id 를 **여기서 만들어** 넘기면 기다릴 이유가 없어진다.
   *
   * ⚠️ 돌려주는 `write` 를 노출 기록이 기다려야 한다 — FK 때문이다
   *    ([RenderContext.messageWrite](./search.types.ts)).
   */
  private logMessage(
    req: RouterRequest,
    kind: SearchKind,
    placeSlug: string | null,
  ): PendingMessage {
    const id = randomUUID();
    const write = this.messages
      .log({
        id,
        userId: req.userId,
        domain: kind,
        utterance: req.utterance,
        blockName: null,
        parsedCity: placeSlug,
        params: {},
        rawPayload: null,
      })
      .catch((err) => {
        this.logger.warn(`message log failed id=${id} err=${err}`);
        return null;
      });
    return { id, write };
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
/**
 * 검색 한 번의 맥락. **즉시 경로와 느린 경로가 같은 값을 써야 한다** —
 * 둘이 갈리면 "미리 본 것과 나중에 온 것이 다른" 버그가 된다.
 */
function ctx(
  kind: SearchKind,
  place: Place,
  parent: Place | null,
  from: Place | null,
  parsed: ParsedIntent,
  config: AppConfig,
): SearchContext {
  return { kind, place, parent, from, tripType: parsed.tripType, limit: config.resultMaxItems };
}

export function cacheKeyOf(
  kind: SearchKind,
  place: Place,
  from: Place | null,
  tripType: TripType,
): string {
  if (kind === 'flight') return `flight:${from?.id ?? 0}>${place.id}:${tripType}`;
  return `${kind}:${place.id}`;
}

/**
 * 이 페이지에 **제휴 링크가 섞여 있는가.** 카드 아래 고지 한 줄이 여기서 갈린다.
 *
 * 줄마다 판정이 다르다 — 항공권은 제휴를 타는 도메인인데 스카이스캐너 줄만 못 탄다
 * (애드픽에 광고주가 없다). 그래서 kind 만으로는 정할 수 없고 줄을 봐야 한다.
 *
 * ⚠️ **관광지는 줄을 보지 않고 제외한다.** 제휴 단계가 아예 없고(`/a/{id}` 로 바로
 *    간다) merchant 칸도 없는데, `adpickCarries(undefined)` 는 "모르면 취급한다"
 *    쪽이라 true 를 준다 — 줄만 보면 관광지에도 고지가 붙는다.
 *
 * ⚠️ **리다이렉트와 같은 함수로 판정한다.** 두 곳이 각자 기억하면 언젠가 갈리고,
 *    그러면 고지가 붙은 줄이 제휴를 안 타거나 그 반대가 된다.
 */
export function carriesAffiliate(kind: SearchKind, page: unknown[]): boolean {
  if (kind === 'attraction') return false;
  return page.some((item) =>
    adpickCarries((item as { merchant?: string | null } | null)?.merchant ?? null),
  );
}

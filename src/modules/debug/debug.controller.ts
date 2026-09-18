import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AppConfig, CONFIG, openaiEnabled } from '../../config/app.config';
import { AttractionService } from '../attraction/attraction.service';
import { FlightService } from '../flight/flight.service';
import { HotelService } from '../hotel/hotel.service';
import { IntentService } from '../intent/intent.service';
import * as cards from '../kakao/cards';
import * as t from '../kakao/templates';
import { PlacesService } from '../places/places.service';
import { cacheKeyOf } from '../search/search.service';
import {
  SearchContext,
  SearchDomain,
  SearchKind,
  SearchMeta,
} from '../search/search.types';

/**
 * 진단용 **동기** 실행.
 *
 * 라우터는 5초 예산 때문에 검색을 백그라운드로 던진다. 그래서 스킬 응답만 봐서는
 * **검색이 성공했는지 실패했는지 알 수가 없다** — 늘 "찾고 있어요" 다. 여기서는 검색이
 * 끝날 때까지 기다렸다가 사용자에게 실제로 배달될 말풍선을 그대로 돌려준다.
 *
 * 카드 조립은 운영과 **같은 코드**를 태운다(도메인의 `rows`). 진단용 카드를 따로 만들면
 * 그건 실제 응답을 검증하는 게 아니라 비슷한 걸 하나 더 만드는 것이다.
 *
 * ⚠️ **캐시를 타지 않는다.** 호출 한 번이 곧 OpenAI 요금이다. 그래서 토큰으로 막는다.
 * ⚠️ **통계를 남기지 않는다** (`persist: false`). 진단 호출이 섞이면 전환율이 틀어진다.
 *    다만 clickId 는 인메모리에 남으므로 `/r/{clickId}` 로 이동까지 확인할 수 있다.
 */
@ApiTags('진단')
@ApiHeader({
  name: 'X-Debug-Token',
  required: false,
  description: 'DEBUG_TOKEN 을 설정한 경우 필수. 비어 있으면 이 경로는 404 다.',
})
@Controller('api/v1/debug')
export class DebugController {
  private readonly logger = new Logger(DebugController.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly intent: IntentService,
    private readonly places: PlacesService,
    private readonly hotels: HotelService,
    private readonly flights: FlightService,
    private readonly attractions: AttractionService,
  ) {}

  @Post('parse')
  @ApiOperation({
    summary: '발화 해석만 (모델 1회) — 의도·지역·무시된 조건',
    description:
      '라우터가 5초 예산 안에서 하는 일까지만 돌린다: 의도·지역 추출 + 지역 정규화.\n\n' +
      '검색은 하지 않으므로 싸고 빠르다. "왜 도움말이 나오지?" 를 가릴 때 먼저 여기를 본다 — ' +
      '`intent` 가 unknown 인지, `place` 를 못 뽑은 건지, 지역이 엉뚱하게 정규화된 건지가 갈린다.',
  })
  @ApiBody({
    schema: { type: 'object', properties: { utterance: { type: 'string' } } },
    examples: { 호텔: { value: { utterance: '오사카 호텔 4명 9월 22~24일 추천해줘' } } },
  })
  async parse(
    @Body() body: { utterance?: string },
    @Headers('x-debug-token') token?: string,
  ): Promise<Record<string, unknown>> {
    this.authorize(token);
    const utterance = (body?.utterance ?? '').trim();

    const started = Date.now();
    const parsed = await this.intent.extract(utterance);
    const parseMs = Date.now() - started;

    const place = parsed.place ? await this.places.resolve(parsed.place) : null;
    const parent = place ? await this.places.parentOf(place) : null;
    // 항공권 캐시 키에는 출발지가 들어간다. 여기서도 채워야 진짜 키와 같아진다.
    const from =
      place && parsed.intent === 'flight'
        ? await this.places.resolve(parsed.from ?? this.config.flightDefaultOriginName)
        : null;

    return {
      utterance,
      intent: parsed,
      place,
      parent,
      from,
      cacheKey:
        place && parsed.intent !== 'unknown'
          ? cacheKeyOf(parsed.intent, place, from, parsed.tripType)
          : null,
      timing: { parseMs, totalMs: Date.now() - started },
      openaiEnabled: openaiEnabled(this.config),
    };
  }

  @Post('search')
  @ApiOperation({
    summary: '전체 파이프라인 (동기) — 사용자가 실제로 보는 말풍선 그대로',
    description:
      '```\n발화 → 의도·지역 추출 → 지역 정규화 → AI 검색 → 카드 조립\n```\n\n' +
      '⚠️ **라우터의 즉시 응답과는 다르다.** 캐시 미스면 거기서는 `useCallback` 만 나가고 ' +
      '이 카드는 잠시 뒤 **콜백으로** 배달된다 — 여기 나오는 건 그 콜백 본문이다.\n\n' +
      '⚠️ 호출 한 번이 OpenAI 요금이다 (7~30초). 캐시를 읽지도 쓰지도 않는다.',
  })
  @ApiBody({
    schema: { type: 'object', properties: { utterance: { type: 'string' } } },
    examples: {
      호텔: { value: { utterance: '오사카 호텔 추천해줘' } },
      항공권: { value: { utterance: '오사카 항공권 찾아줘' } },
      관광지: { value: { utterance: '도톤보리 맛집 알려줘' } },
    },
  })
  @ApiResponse({ status: 201, description: '검색 결과 + 실제 카드 JSON' })
  async search(
    @Body() body: { utterance?: string },
    @Headers('x-debug-token') token?: string,
  ): Promise<Record<string, unknown>> {
    this.authorize(token);
    const utterance = (body?.utterance ?? '').trim();
    const started = Date.now();

    const parsed = await this.intent.extract(utterance);
    if (parsed.intent === 'unknown' || !parsed.place) {
      return { utterance, intent: parsed, response: cards.helpCard() };
    }

    const place = await this.places.resolve(parsed.place);
    if (!place) return { utterance, intent: parsed, response: cards.helpCard() };

    const kind = parsed.intent;
    const parent = await this.places.parentOf(place);
    const from =
      kind === 'flight'
        ? await this.places.resolve(parsed.from ?? this.config.flightDefaultOriginName)
        : null;

    const meta: SearchMeta = {
      kind,
      placeName: place.canonicalName,
      placeSlug: place.slug,
      fromName: from?.canonicalName ?? null,
      tripType: kind === 'flight' ? parsed.tripType : null,
      originAssumed: kind === 'flight' ? !parsed.from : false,
    };
    const ctx: SearchContext = {
      kind,
      place,
      parent,
      from,
      tripType: parsed.tripType,
      limit: this.config.resultMaxItems,
    };

    const domain = this.domainOf(kind);
    const searchStarted = Date.now();
    const items = await domain.search(ctx);
    const searchMs = Date.now() - searchStarted;

    if (!items.length) {
      return {
        utterance,
        intent: parsed,
        place,
        items: [],
        timing: { searchMs, totalMs: Date.now() - started },
        response: cards.emptyText(meta),
      };
    }

    // 운영과 같은 조립 코드를 태운다. 통계만 남기지 않는다.
    const rows = await domain.rows(items.slice(0, t.MAX_LIST_ITEMS), {
      meta,
      userId: null,
      messageId: null,
      started,
      cacheHit: false,
      persist: false,
    });

    return {
      utterance,
      intent: parsed,
      place,
      cacheKey: cacheKeyOf(kind, place, from, parsed.tripType),
      itemCount: items.length,
      items,
      timing: { searchMs, totalMs: Date.now() - started },
      response: t.listCardWithNotice(
        {
          headerTitle: domain.headerTitle(meta, rows.length, 0),
          items: rows,
        },
        cards.noticeText({ ignored: parsed.ignored, meta }),
        domain.quickReplies(meta),
      ),
    };
  }

  // ---------------------------------------------------------------- 내부
  private domainOf(kind: SearchKind): SearchDomain {
    if (kind === 'flight') return this.flights;
    if (kind === 'attraction') return this.attractions;
    return this.hotels;
  }

  /**
   * DEBUG_TOKEN 이 비어 있으면 **경로 자체가 없는 것처럼** 404 를 낸다.
   *
   * 401 을 주면 "토큰만 알면 열린다" 는 사실이 새어 나간다. 운영에서 진단을 아예
   * 닫아두고 싶을 때 설정을 비우는 것으로 끝나야 한다.
   */
  private authorize(token?: string): void {
    const expected = this.config.debugToken;
    if (!expected) throw new NotFoundException();
    if (!token || !safeEqual(token, expected)) throw new UnauthorizedException();
  }
}

/** 타이밍 공격을 막는다. 토큰 비교는 길이가 같아도 조기 종료되면 안 된다. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest('hex');
  const hb = createHash('sha256').update(b).digest('hex');
  return ha === hb;
}

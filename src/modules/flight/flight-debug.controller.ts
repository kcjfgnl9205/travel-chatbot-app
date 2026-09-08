import {
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  NotFoundException,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AppConfig, CONFIG, openaiEnabled } from '../../config/app.config';
import { AffiliateService, ResolvedLink } from '../affiliate/affiliate.service';
import { keyFingerprint, failureHint } from '../hotel/hotel-debug.controller';
import * as t from '../kakao/templates';
import { FlightNluService, hasRoute } from '../nlu/flight-nlu.service';
import { FlightService, cardHead, itemLabel } from './flight.service';
import { cardRows } from './flight.types';
import { OpenAiFlightProvider, routeText } from './providers/openai.provider';

/**
 * 진단용 동기 검색 (항공권).
 *
 * 카카오 경로는 5초 예산 때문에 검색을 백그라운드로 던진다. 그래서 스킬 엔드포인트
 * 응답만 봐서는 **검색이 성공했는지 실패했는지 알 수가 없다** — 늘 "찾고 있어요" 다.
 * 여기서는 검색이 끝날 때까지 기다렸다가 결과와 단계별 소요 시간을 그대로 돌려준다.
 *
 * ⚠️ 호출 한 번이 곧 OpenAI 요금이고 캐시도 타지 않는다. 그래서 토큰으로 막는다.
 */
@ApiTags('진단')
@ApiHeader({
  name: 'X-Debug-Token',
  required: false,
  description: 'DEBUG_TOKEN 을 설정한 경우 필수. 운영에서 DEBUG_TOKEN 이 비어 있으면 404.',
})
@Controller('api/v1/debug')
export class FlightDebugController {
  private readonly logger = new Logger(FlightDebugController.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly nlu: FlightNluService,
    private readonly provider: OpenAiFlightProvider,
    private readonly affiliate: AffiliateService,
    // 카드 조립은 스킬 경로와 **같은 코드**를 태운다. 진단용으로 따로 만들면
    // 그건 실제 응답을 검증하는 게 아니라 비슷한 걸 하나 더 만드는 것이다.
    private readonly flights: FlightService,
  ) {}

  @Get('flight-search')
  @ApiOperation({
    summary: '항공권 검색 전체 파이프라인 (동기) — 사용자가 실제로 보는 말풍선 그대로',
    description:
      '검색이 끝났을 때 **사용자에게 실제로 배달되는 말풍선 JSON** 을 그대로 돌려준다.\n\n' +
      '```\n발화 → gpt-5-nano 파싱 → gpt-5-mini 웹 검색 → gpt-5-mini 선별 → itemCard 캐러셀\n```\n\n' +
      '⚠️ **스킬 엔드포인트의 즉시 응답과는 다르다.** 캐시 미스면 거기서는 `useCallback` 만 ' +
      '나가고 이 카드는 잠시 뒤 **콜백으로** 배달된다 — 여기 나오는 건 그 콜백 본문이다.\n\n' +
      '**진단 정보는 `trace=true` 를 붙여야 `debug` 키로 붙는다.** 특히 봐야 할 것:\n' +
      '- `parsed.departDate` — 상대 날짜("다음달 3일")가 절대 날짜로 바뀌었는가\n' +
      '- `counts.searchCalls` — 0 이면 모델이 웹 검색을 안 하고 기억으로 답한 것이다(운임을 믿을 수 없다)\n' +
      '- `counts.affiliateFallback` — 0 이 아니면 그만큼 수익화가 안 된다\n' +
      '- `flights[].cardRows` — 카카오 itemCard 에 실제로 찍히는 줄. 6자/20자 제한에 걸리는지 눈으로 확인\n\n' +
      '⚠️ 호출 한 번이 OpenAI 요금이다. `DEBUG_TOKEN` 을 채워두면 헤더 검증을 한다.',
  })
  @ApiQuery({
    name: 'utterance',
    required: true,
    description: '사용자가 카카오에 실제로 치는 문장 그대로.',
    example: '다음달 3일에 오사카 왕복 항공권 2명 찾아줘',
  })
  @ApiQuery({
    name: 'trace',
    required: false,
    description: '단계별 소요 시간·개수·설정·실패 원인을 `debug` 키로 같이 준다 (기본 false).',
    example: false,
  })
  @ApiQuery({
    name: 'affiliate',
    required: false,
    description:
      '애드픽 커미션 링크 변환 (**기본 켜짐**). 끄려면 `affiliate=false`. ' +
      '카드 JSON 은 켜든 끄든 같다 — 버튼 링크는 `/r/{clickId}` 이고 애드픽 주소는 그 302 목적지다.',
    example: true,
  })
  @ApiQuery({
    name: 'candidates',
    required: false,
    description: '1차 웹 검색 원문을 `debug` 에 포함한다 (길다, `trace=true` 필요, 기본 false)',
    example: false,
  })
  @ApiResponse({ status: 200, description: '스킬 응답 그대로. `trace=true` 면 `debug` 가 붙는다.' })
  async flightSearch(
    @Headers('x-debug-token') token: string | undefined,
    @Query('utterance') utterance?: string,
    @Query('affiliate') affiliate?: string,
    @Query('candidates') candidates?: string,
    @Query('trace') trace?: string,
  ): Promise<Record<string, unknown>> {
    this.assertAllowed(token);

    const said = (utterance ?? '').trim();
    if (!said) throw new NotFoundException('utterance 파라미터가 필요합니다');

    const runStarted = Date.now();
    const wantTrace = isTrue(trace);
    const answer = (
      response: t.Json,
      debug: Record<string, unknown>,
    ): Record<string, unknown> => (wantTrace ? { ...response, debug } : response);

    const openai = {
      enabled: openaiEnabled(this.config),
      model: this.config.openaiModel,
      searchEffort: this.config.openaiSearchEffort,
      rankEffort: this.config.openaiRankEffort,
      candidateCount: this.config.openaiCandidateCount,
      timeoutMs: this.config.openaiTimeoutMs,
      parseModel: this.config.openaiParseModel,
      parseTimeoutMs: this.config.openaiParseTimeoutMs,
      apiBase: this.config.openaiApiBase,
      project: this.config.openaiProject || null,
      organization: this.config.openaiOrganization || null,
      key: keyFingerprint(this.config.openaiApiKey),
    };

    // ① 발화 파싱 — try 밖에 둔다. 검색이 터졌을 때 파싱 결과까지 같이 날려버리면
    //    "파싱은 됐는데 검색이 죽었다"를 못 본다.
    const outcome = await this.nlu.resolveDetailed(said, {}, { fresh: true });
    const { parsed } = outcome;
    const parseMs = outcome.ms;
    const parse = {
      source: outcome.source,
      model: this.config.openaiParseModel,
      timeoutMs: this.config.openaiParseTimeoutMs,
      timedOut: outcome.timedOut,
      error: outcome.error,
    };

    try {
      if (!hasRoute(parsed)) {
        this.logger.log(
          `debug flight "${said}" → 목적지 없음 (${parseMs}ms) reason=${outcome.error ?? '모델이 null 반환'}`,
        );
        // 스킬 경로가 이 상황에서 내보내는 되묻기 말풍선 그대로.
        return answer(this.flights.askRoute(), {
          ok: false,
          utterance: said,
          parsed,
          parse,
          query: null,
          openai,
          timings: { parseMs, searchMs: 0, rankMs: 0, affiliateMs: 0, totalMs: parseMs },
          counts: null,
          flights: [],
          error: outcome.error,
        });
      }

      const query = this.flights.queryOf(parsed);

      // ② 웹 검색 + 선별
      const result = await this.provider.searchTraced(query);

      // ③ 애드픽 변환. **기본으로 켠다** — 끄면 "커미션 링크가 나가고 있나"를
      //    확인하려고 부른 진단이 거짓말을 한다.
      let affiliateMs = 0;
      let links = new Map<string, ResolvedLink>();
      if (isTrueByDefault(affiliate) && result.flights.length) {
        const started = Date.now();
        links = await this.affiliate.resolve(
          result.flights.map((f) => ({ sourceUrl: f.sourceUrl, merchant: f.merchant })),
        );
        affiliateMs = Date.now() - started;
      }

      // ④ 카드 조립 — 스킬 경로와 같은 코드. 통계는 남기지 않는다.
      const response = await this.flights.previewResponse(result.flights, query, {
        started: runStarted,
        links,
      });

      const converted = countConverted(result.flights, links);
      this.logger.log(
        `debug flight "${said}" → ${routeText(query)} ok flights=${result.flights.length} ` +
          `parse=${parseMs}ms total=${parseMs + result.trace.totalMs + affiliateMs}ms`,
      );

      return answer(response, {
        // 키가 없거나 결과가 0이면 성공이 아니다 — 여기가 이 엔드포인트의 존재 이유다.
        ok: openai.enabled && result.flights.length > 0,
        utterance: said,
        parsed,
        parse,
        query,
        route: routeText(query),
        openai,
        timings: {
          parseMs,
          searchMs: result.trace.searchMs,
          rankMs: result.trace.rankMs,
          affiliateMs,
          totalMs: parseMs + result.trace.totalMs + affiliateMs,
        },
        counts: {
          searchCalls: result.trace.searchCalls,
          candidateChars: result.trace.candidateChars,
          candidates: result.trace.candidates,
          picks: result.trace.picks,
          droppedUntrusted: result.trace.droppedUntrusted,
          flights: result.trace.flights,
          affiliateConverted: converted,
          affiliateFallback: result.flights.length - converted,
        },
        flights: result.flights.map((f) => ({
          label: itemLabel(f),
          airline: f.airline,
          flightNo: f.flightNo,
          route: `${f.originCode}→${f.destCode}`,
          departDate: f.departDate,
          departTime: f.departTime,
          arriveTime: f.arriveTime,
          returnDate: f.returnDate,
          durationMinutes: f.durationMinutes,
          stops: f.stops,
          priceFrom: f.priceFrom,
          merchant: f.merchant,
          sourceUrl: f.sourceUrl,
          // 카카오 itemCard 에 실제로 찍힐 줄. 6자/20자 제한에 걸리는지 눈으로 확인.
          cardHead: cardHead(f, query),
          cardRows: cardRows(f),
          affiliateUrl: links.get(f.sourceUrl)?.affiliateUrl ?? null,
          affiliateStatus: links.get(f.sourceUrl)?.status ?? null,
          // /r/{clickId} 가 실제로 보낼 곳. 원본과 같으면 커미션이 안 붙은 것이다.
          linkConverted: isConverted(f.sourceUrl, links),
        })),
        candidates: isTrue(candidates) ? result.candidates : null,
        hint: hintFor(openai.enabled, result.flights.length, result.trace.searchCalls),
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`debug flight "${said}" failed err=${message}`);
      // 던지지 않는다. 실패 내용을 응답으로 봐야 하는 게 이 엔드포인트의 목적이다.
      return answer(
        // 스킬 컨트롤러가 예외를 삼키고 내보내는 것과 같은 말풍선.
        t.simpleText(
          '일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏',
          this.flights.routeQuickReplies(),
        ),
        {
          ok: false,
          utterance: said,
          parsed,
          parse,
          query: hasRoute(parsed) ? this.flights.queryOf(parsed) : null,
          openai,
          timings: { parseMs, searchMs: 0, rankMs: 0, affiliateMs: 0, totalMs: parseMs },
          counts: null,
          flights: [],
          hint: failureHint(message),
          error: message,
        },
      );
    }
  }

  /**
   * DEBUG_TOKEN 이 있으면 헤더를 검증하고, 없으면 운영에서만 막는다.
   *
   * /docs 가 공개돼 있으므로 운영에 무방비로 열어두면 아무나 우리 OpenAI 요금을 태울 수 있다.
   */
  private assertAllowed(token: string | undefined): void {
    const expected = this.config.debugToken;
    if (!expected) {
      if (this.config.appEnv === 'production') {
        throw new NotFoundException('DEBUG_TOKEN 이 설정되지 않았습니다');
      }
      return;
    }
    if (token !== expected) throw new UnauthorizedException('invalid debug token');
  }
}

const isTrue = (v?: string): boolean =>
  ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase());

/** 값을 안 주면 켜진 것으로 본다. 끄려면 명시적으로 false 를 넣어야 한다. */
const isTrueByDefault = (v?: string): boolean => (v === undefined ? true : isTrue(v));

/**
 * 목적지가 원본 주소와 다른가 = 커미션 링크로 바뀌었는가.
 *
 * `status` 로 판단하지 않는다. 애드픽 API 가 실패해도 템플릿 폴백이 status 를
 * 채워주기 때문에, "정말 다른 주소로 나가는가"만이 믿을 수 있는 신호다.
 */
function isConverted(sourceUrl: string, links: Map<string, ResolvedLink>): boolean {
  const url = links.get(sourceUrl)?.affiliateUrl;
  return Boolean(url) && url !== sourceUrl;
}

function countConverted(
  flights: { sourceUrl: string }[],
  links: Map<string, ResolvedLink>,
): number {
  return flights.filter((f) => isConverted(f.sourceUrl, links)).length;
}

/** 결과가 비었거나 수상할 때 "그래서 뭘 봐야 하는지"를 알려준다. */
export function hintFor(
  enabled: boolean,
  flights: number,
  searchCalls: number,
): string | null {
  if (!enabled) return 'OPENAI_API_KEY 가 없습니다. 검색이 아예 시도되지 않습니다.';
  if (!flights) {
    return (
      '후보를 못 모았거나 전부 허용 호스트 밖의 링크였습니다. ' +
      'trace 의 counts.candidates 와 counts.droppedUntrusted 를 비교하세요 — ' +
      'droppedUntrusted 가 크면 모델이 trip.com/myrealtrip.com 이 아닌 사이트를 가져오는 것이라 ' +
      'FLIGHT_ALLOWED_HOSTS 와 프롬프트를 같이 손봐야 합니다.'
    );
  }
  if (!searchCalls) {
    return (
      '모델이 web_search 를 한 번도 안 돌리고 기억으로 답했습니다. ' +
      '항공 운임은 실시간이라 이 결과의 가격은 믿을 수 없습니다 — ' +
      'OPENAI_SEARCH_EFFORT 를 올리거나 프롬프트의 검색 지시를 확인하세요.'
    );
  }
  return null;
}

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
import { keyFingerprint, failureHint } from '../hotel/hotel-debug.controller';
import * as t from '../kakao/templates';
import { hasCity } from '../nlu/nlu';
import { NluService } from '../nlu/nlu.service';
import { AttractionService } from './attraction.service';
import { AttractionQuery, listDescription } from './attraction.types';
import { OpenAiAttractionProvider } from './providers/openai.provider';

/**
 * 진단용 동기 검색 (관광지).
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
export class AttractionDebugController {
  private readonly logger = new Logger(AttractionDebugController.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly nlu: NluService,
    private readonly provider: OpenAiAttractionProvider,
    // 카드 조립은 스킬 경로와 **같은 코드**를 태운다. 진단용으로 따로 만들면
    // 그건 실제 응답을 검증하는 게 아니라 비슷한 걸 하나 더 만드는 것이다.
    private readonly attractions: AttractionService,
  ) {}

  @Get('attraction-search')
  @ApiOperation({
    summary: '관광지 추천 전체 파이프라인 (동기) — 사용자가 실제로 보는 말풍선 그대로',
    description:
      '검색이 끝났을 때 **사용자에게 실제로 배달되는 말풍선 JSON** 을 그대로 돌려준다.\n\n' +
      '```\n발화 → gpt-5-nano 파싱 → gpt-5-mini 웹 검색 → gpt-5-mini 선별 → listCard\n```\n\n' +
      '⚠️ **스킬 엔드포인트의 즉시 응답과는 다르다.** 캐시 미스면 거기서는 `useCallback` 만 ' +
      '나가고 이 카드는 잠시 뒤 **콜백으로** 배달된다 — 여기 나오는 건 그 콜백 본문이다.\n\n' +
      '호텔·항공권 진단과 달리 `affiliate` 파라미터가 없다. **관광지는 제휴 링크를 타지 않는다** — ' +
      '줄 링크의 목적지는 우리가 이름+도시로 만든 구글맵 주소다.\n\n' +
      '`trace=true` 에서 볼 것:\n' +
      '- `counts.searchCalls` — 0 이면 모델이 웹 검색 없이 기억으로 답한 것이다(입장료·폐관 여부가 낡을 수 있다)\n' +
      '- `attractions[].mapUrl` — 실제로 열릴 지도 링크. 브라우저에 붙여 넣어 엉뚱한 곳이 아닌지 확인\n' +
      '- `attractions[].cardDescription` — 카카오 카드에 찍히는 40자 줄\n' +
      '- `counts.categories` — 카테고리가 쏠렸는지. 전부 같으면 선별 프롬프트가 안 먹은 것이다\n\n' +
      '⚠️ 호출 한 번이 OpenAI 요금이다. `DEBUG_TOKEN` 을 채워두면 헤더 검증을 한다.',
  })
  @ApiQuery({
    name: 'utterance',
    required: true,
    description: '사용자가 카카오에 실제로 치는 문장 그대로.',
    example: '오사카 관광지 추천해줘',
  })
  @ApiQuery({
    name: 'trace',
    required: false,
    description: '단계별 소요 시간·개수·설정·실패 원인을 `debug` 키로 같이 준다 (기본 false).',
    example: false,
  })
  @ApiQuery({
    name: 'candidates',
    required: false,
    description: '1차 웹 검색 원문을 `debug` 에 포함한다 (길다, `trace=true` 필요, 기본 false)',
    example: false,
  })
  @ApiResponse({ status: 200, description: '스킬 응답 그대로. `trace=true` 면 `debug` 가 붙는다.' })
  async attractionSearch(
    @Headers('x-debug-token') token: string | undefined,
    @Query('utterance') utterance?: string,
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
    const outcome = await this.nlu.resolveDetailed(said, null, { fresh: true });
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
      if (!hasCity(parsed)) {
        this.logger.log(
          `debug attraction "${said}" → 도시 없음 (${parseMs}ms) reason=${outcome.error ?? '모델이 null 반환'}`,
        );
        // 스킬 경로가 이 상황에서 내보내는 되묻기 말풍선 그대로.
        return answer(this.attractions.askCity(), {
          ok: false,
          utterance: said,
          parsed,
          parse,
          query: null,
          openai,
          timings: { parseMs, searchMs: 0, rankMs: 0, totalMs: parseMs },
          counts: null,
          attractions: [],
          error: outcome.error,
        });
      }

      const query: AttractionQuery = {
        citySlug: parsed.citySlug ?? '',
        cityName: parsed.cityName ?? '',
        limit: this.config.attractionResultLimit,
      };

      // ② 웹 검색 + 선별
      const result = await this.provider.searchTraced(query);

      // ③ 카드 조립 — 스킬 경로와 같은 코드. 통계는 남기지 않는다.
      //    애드픽 단계가 없으므로 호텔·항공권 진단보다 단계가 하나 적다.
      const response = await this.attractions.previewResponse(result.attractions, query, {
        started: runStarted,
      });

      this.logger.log(
        `debug attraction "${said}" → ${query.citySlug} ok attractions=${result.attractions.length} ` +
          `parse=${parseMs}ms total=${parseMs + result.trace.totalMs}ms`,
      );

      return answer(response, {
        // 키가 없거나 결과가 0이면 성공이 아니다 — 여기가 이 엔드포인트의 존재 이유다.
        ok: openai.enabled && result.attractions.length > 0,
        utterance: said,
        parsed,
        parse,
        query,
        openai,
        timings: {
          parseMs,
          searchMs: result.trace.searchMs,
          rankMs: result.trace.rankMs,
          totalMs: parseMs + result.trace.totalMs,
        },
        counts: {
          searchCalls: result.trace.searchCalls,
          candidateChars: result.trace.candidateChars,
          candidates: result.trace.candidates,
          picks: result.trace.picks,
          droppedInvalid: result.trace.droppedInvalid,
          attractions: result.trace.attractions,
          // 카테고리가 쏠렸는지. 전부 같으면 선별 프롬프트가 안 먹은 것이다.
          categories: countBy(result.attractions.map((a) => a.category ?? '미분류')),
          free: result.attractions.filter((a) => a.free).length,
        },
        attractions: result.attractions.map((a) => ({
          name: a.name,
          category: a.category,
          area: a.area,
          description: a.description,
          free: a.free,
          admissionFee: a.admissionFee,
          // 금액만 보면 원인지 엔인지 알 수 없다. 카드가 맞아도 trace 가 거짓말한다.
          admissionCurrency: a.admissionCurrency,
          durationMinutes: a.durationMinutes,
          tags: a.tags,
          // 실제로 열릴 지도 링크. 붙여 넣어 엉뚱한 곳이 아닌지 확인할 수 있다.
          mapUrl: a.mapUrl,
          // 카카오 카드에 실제로 찍힐 문구. 40자 제한에 걸리는지 눈으로 확인.
          cardDescription: listDescription(a),
        })),
        candidates: isTrue(candidates) ? result.candidates : null,
        hint: hintFor(openai.enabled, result.attractions.length, result.trace.searchCalls),
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`debug attraction "${said}" failed err=${message}`);
      // 던지지 않는다. 실패 내용을 응답으로 봐야 하는 게 이 엔드포인트의 목적이다.
      return answer(
        // 스킬 컨트롤러가 예외를 삼키고 내보내는 것과 같은 말풍선.
        t.simpleText(
          '일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏',
          this.attractions.cityQuickReplies(),
        ),
        {
          ok: false,
          utterance: said,
          parsed,
          parse,
          query: hasCity(parsed)
            ? {
                citySlug: parsed.citySlug,
                cityName: parsed.cityName,
                limit: this.config.attractionResultLimit,
              }
            : null,
          openai,
          timings: { parseMs, searchMs: 0, rankMs: 0, totalMs: parseMs },
          counts: null,
          attractions: [],
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

function countBy(values: string[]): Record<string, number> {
  const bucket: Record<string, number> = {};
  for (const v of values) bucket[v] = (bucket[v] ?? 0) + 1;
  return bucket;
}

/** 결과가 비었거나 수상할 때 "그래서 뭘 봐야 하는지"를 알려준다. */
export function hintFor(
  enabled: boolean,
  attractions: number,
  searchCalls: number,
): string | null {
  if (!enabled) return 'OPENAI_API_KEY 가 없습니다. 검색이 아예 시도되지 않습니다.';
  if (!attractions) {
    return (
      '후보를 못 모았습니다. trace 의 counts.candidates 를 보세요 — 0 이면 1차 웹 검색 ' +
      '프롬프트가 안 먹은 것이고(원문은 candidates=true), 0 이 아닌데 결과가 없으면 ' +
      '2차 선별이 빈 배열을 준 것입니다.'
    );
  }
  if (!searchCalls) {
    return (
      '모델이 web_search 를 한 번도 안 돌리고 기억으로 답했습니다. 관광지는 URL 을 ' +
      '모델에게 받지 않아 링크가 깨질 위험은 없지만, **입장료와 폐관 여부가 낡을 수 있습니다** — ' +
      'OPENAI_SEARCH_EFFORT 를 올리거나 프롬프트의 검색 지시를 확인하세요.'
    );
  }
  return null;
}

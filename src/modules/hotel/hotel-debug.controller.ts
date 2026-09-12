import { createHash } from 'node:crypto';

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
import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AppConfig, CONFIG, openaiEnabled } from '../../config/app.config';
import { AffiliateService, ResolvedLink } from '../affiliate/affiliate.service';
import * as t from '../kakao/templates';
import { hasCity } from '../nlu/nlu';
import { NluService } from '../nlu/nlu.service';
import { HotelService } from './hotel.service';
import { HotelQuery, listDescription } from './hotel.types';
import { OpenAiHotelProvider, SearchTrace } from './providers/openai.provider';

/**
 * 진단용 동기 검색.
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
  description:
    'DEBUG_TOKEN 을 설정한 경우 필수. 운영에서 DEBUG_TOKEN 이 비어 있으면 404.',
})
@Controller('api/v1/debug')
export class HotelDebugController {
  private readonly logger = new Logger(HotelDebugController.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly nlu: NluService,
    private readonly provider: OpenAiHotelProvider,
    private readonly affiliate: AffiliateService,
    // 카드 조립은 스킬 경로와 **같은 코드**를 태운다. 진단용으로 따로 만들면
    // 그건 실제 응답을 검증하는 게 아니라 비슷한 걸 하나 더 만드는 것이다.
    private readonly hotels: HotelService,
  ) {}

  @Get('hotel-search')
  @ApiOperation({
    summary: '호텔 추천 전체 파이프라인 (동기) — 사용자가 실제로 보는 말풍선 그대로',
    description:
      '검색이 끝났을 때 **사용자에게 실제로 배달되는 말풍선 JSON** 을 그대로 돌려준다.\n\n' +
      '⚠️ **스킬 엔드포인트의 즉시 응답과는 다르다.** 캐시 미스면 거기서는 `useCallback` 만 ' +
      '나가고 이 카드는 잠시 뒤 **콜백으로** 배달된다 — 여기 나오는 건 그 콜백 본문이다. ' +
      '(캐시 히트일 때만 스킬 응답 자체와 같다)\n\n' +
      '```\n발화 → gpt-5-mini 파싱 → gpt-5-mini 웹 검색 → gpt-5-mini 선별 → 카드 조립\n```\n\n' +
      '스킬 엔드포인트는 5초 예산 때문에 검색을 백그라운드로 던진다. 그래서 거기서는 늘 ' +
      '"찾고 있어요" 만 나오고 **진짜 카드는 콜백을 받기 전에는 볼 수 없다.** ' +
      '여기서는 검색이 끝날 때까지 기다렸다가 그 카드를 그대로 보여준다.\n\n' +
      '조립은 `HotelService` 의 **같은 코드**를 태운다 — 제목 40자 잘림, 설명 문구, ' +
      '줄 링크(`/r/{clickId}`), 버튼·퀵리플라이까지 운영과 동일하다. ' +
      '도시를 못 알아들으면 되묻기가, 결과가 없으면 그 안내 문구가 온다.\n\n' +
      '**진단 정보는 `trace=true` 를 붙여야 `debug` 키로 붙는다.** ' +
      '단계별 소요 시간·후보 개수·OpenAI 설정·실패 원인이 거기 들어 있다.\n\n' +
      '- **캐시를 타지 않는다.** 발화 파싱도 호텔 검색도 매번 실제로 부른다 (그게 목적이다)\n' +
      '- **통계를 남기지 않는다.** 진단 호출로 `recommendations` 가 오염되지 않는다\n' +
      '- 다만 `clickId` 는 인메모리에 남으므로 **줄 링크를 눌러 이동까지 확인할 수 있다**\n' +
      '- 실패해도 200 이고, 카카오에 나갈 안내 문구가 그대로 온다 (원인은 `trace=true` 로)\n\n' +
      '⚠️ 호출 한 번이 OpenAI 요금이다. `DEBUG_TOKEN` 을 채워두면 헤더 검증을 한다.',
  })
  @ApiQuery({
    name: 'utterance',
    required: true,
    description:
      '사용자가 카카오에 실제로 치는 문장 그대로. 도시명만 넣어도 된다.',
    example: '오사카 여행갈건데 4명기준으로 숙소 추천해줘',
  })
  @ApiQuery({
    name: 'trace',
    required: false,
    description:
      '단계별 소요 시간·개수·설정·실패 원인을 `debug` 키로 같이 준다 (기본 false). ' +
      '끄면 카카오가 받는 것과 **완전히 같은 JSON** 만 나온다.',
    example: false,
  })
  @ApiQuery({
    name: 'affiliate',
    required: false,
    description:
      '애드픽 커미션 링크 변환 (**기본 켜짐**). 끄려면 `affiliate=false`.\n\n' +
      '**카드 JSON 은 켜든 끄든 같다** — 줄 링크는 `/r/{clickId}` 이고 애드픽 주소는 ' +
      '그 302 목적지로만 쓰인다. 끄면 그 목적지가 원본 주소가 되므로, ' +
      '"커미션 링크가 제대로 나가는가"를 보려면 켜둔 채로 확인해야 한다 ' +
      '(`trace=true` 의 `counts.affiliateFallback` 이 0 이어야 정상).',
    example: true,
  })
  @ApiQuery({
    name: 'candidates',
    required: false,
    description: '1차 웹 검색 원문을 `debug` 에 포함한다 (길다, `trace=true` 필요, 기본 false)',
    example: false,
  })
  @ApiResponse({
    status: 200,
    description:
      '스킬 응답 그대로. `trace=true` 면 `debug` 가 붙는다.',
    schema: {
      example: {
        version: '2.0',
        template: {
          outputs: [
            {
              listCard: {
                header: { title: '오사카 호텔 추천 5곳' },
                items: [
                  {
                    title: '호텔 그란비아 오사카',
                    description: '1박 172,000원~ · 평점 9.1 · 우메다',
                    link: { web: 'https://bot.nolmoa.com/r/Ab3xY9kQ2mZp' },
                  },
                ],
                buttons: [
                  {
                    label: '더 보기',
                    action: 'block',
                    blockId: '6a9398f895f722d77da02d42',
                    messageText: '오사카 호텔 더 보기',
                    extra: { city: '오사카', offset: 5 },
                  },
                ],
              },
            },
          ],
          quickReplies: [
            { label: '도쿄 호텔', action: 'message', messageText: '도쿄 호텔 추천해줘' },
          ],
        },
        debug: {
          ok: true,
          utterance: '오사카 여행갈건데 4명기준으로 숙소 추천해줘',
          parsed: { citySlug: 'osaka', cityName: '오사카', guests: 4, nights: null },
          parse: {
            source: 'model',
            model: 'gpt-5-nano',
            timeoutMs: 4000,
            timedOut: false,
            error: null,
          },
          query: { citySlug: 'osaka', cityName: '오사카', guests: 4, limit: 5 },
          openai: { enabled: true, model: 'gpt-5-mini', parseModel: 'gpt-5-nano' },
          timings: {
            parseMs: 780,
            searchMs: 11240,
            rankMs: 3380,
            thumbnailMs: 820,
            affiliateMs: 0,
            totalMs: 16230,
          },
          counts: {
            searchCalls: 3,
            candidateChars: 1832,
            candidates: 12,
            picks: 5,
            droppedUntrusted: 1,
            droppedThumbnails: 2,
            thumbnails: 4,
            thumbnailSources: { og: 3, photo: 1 },
            hotels: 4,
            affiliateConverted: 4,
            affiliateFallback: 0,
          },
          hotels: [
            {
              name: '호텔 그란비아 오사카',
              sourceUrl: 'https://kr.trip.com/hotels/osaka-granvia-12345/',
              merchant: 'trip',
              priceFrom: 172000,
              reviewScore: 9.1,
              thumbnailUrl: 'https://ak-d.tripcdn.com/images/220t18_R_960_660_R5_D.jpg',
              cardDescription: '1박 172,000원~ · 평점 9.1 · 우메다',
              affiliateUrl: 'https://link.adpick.co.kr/xxxxxxxx',
              linkConverted: true,
            },
          ],
          error: null,
        },
      },
    },
  })
  async hotelSearch(
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

    /**
     * 기본은 **스킬 응답 그 자체**다. 진단 정보는 trace=true 일 때만 얹는다.
     *
     * 카카오는 모르는 키를 무시하므로 debug 가 붙어도 렌더링에는 영향이 없다.
     * 그래도 기본을 깨끗하게 두는 이유는, 이 응답을 그대로 복사해
     * 오픈빌더 스킬 테스트에 넣어볼 수 있어야 하기 때문이다.
     */
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
      // 비어 있고 키가 sk-proj- 가 아니면 조직 기본 프로젝트로 붙는다 — 403 의 단골 원인.
      project: this.config.openaiProject || null,
      organization: this.config.openaiOrganization || null,
      // "curl 로는 되는데 앱은 403" 을 끝내려면 두 호출이 같은 키를 쓰는지부터
      // 확정해야 한다. 키 자체는 못 보여주므로 대조 가능한 지문만 낸다.
      key: keyFingerprint(this.config.openaiApiKey),
    };

    // ① 발화 파싱 — 스킬 경로에서 5초 예산을 실제로 깎는 유일한 모델 호출.
    //
    // try 밖에 둔다. 검색이 터졌을 때 파싱 결과까지 같이 날려버리면
    // "파싱은 됐는데 검색이 죽었다"를 못 본다 — 실제로 그 버그가 있었다.
    // (resolveDetailed 는 던지지 않는다. 실패를 outcome.error 로 돌려준다)
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
          `debug search "${said}" → 도시 없음 (${parseMs}ms) reason=${outcome.error ?? '모델이 null 반환'}`,
        );
        // 스킬 경로가 이 상황에서 내보내는 되묻기 말풍선 그대로.
        return answer(this.hotels.askCity(), {
          ok: false,
          utterance: said,
          parsed,
          parse,
          query: null,
          openai,
          timings: {
            parseMs,
            searchMs: 0,
            rankMs: 0,
            thumbnailMs: 0,
            affiliateMs: 0,
            totalMs: parseMs,
          },
          counts: null,
          hotels: [],
          hint: parseHint(
            outcome.timedOut,
            outcome.error,
            this.config.openaiParseTimeoutMs,
          ),
          error: outcome.error,
        });
      }

      const query: HotelQuery = {
        citySlug: parsed.citySlug ?? '',
        cityName: parsed.cityName ?? '',
        guests: parsed.guests,
        limit: this.config.hotelResultLimit,
      };

      // ② 웹 검색 + 선별
      const result = await this.provider.searchTraced(query);

      // ③ 애드픽 변환.
      //
      // **기본으로 켠다.** 끄면 /r/{clickId} 의 목적지가 원본 주소가 되는데,
      // 그러면 "커미션 링크가 나가고 있나"를 확인하려고 부른 진단이 거짓말을 한다.
      // 요금이 아까우면 affiliate=false 로 끌 수 있다 (카드 JSON 은 그대로다).
      let affiliateMs = 0;
      let links = new Map<string, ResolvedLink>();
      if (isTrueByDefault(affiliate) && result.hotels.length) {
        const started = Date.now();
        links = await this.affiliate.resolve(
          result.hotels.map((h) => ({
            sourceUrl: h.sourceUrl,
            merchant: h.merchant,
          })),
        );
        affiliateMs = Date.now() - started;
      }

      // ④ 카드 조립 — 스킬 경로와 같은 코드. 통계는 남기지 않는다.
      //    변환은 위에서 이미 돌렸으므로 그 결과를 넘겨 두 번 부르지 않게 한다.
      const response = await this.hotels.previewResponse(result.hotels, query, {
        started: runStarted,
        links,
      });

      this.logger.log(
        `debug search "${said}" → ${query.citySlug} ok hotels=${result.hotels.length} ` +
          `parse=${parseMs}ms total=${parseMs + result.trace.totalMs + affiliateMs}ms`,
      );

      return answer(response, {
        // 키가 없거나 결과가 0이면 성공이 아니다 — 여기가 이 엔드포인트의 존재 이유다.
        ok: openai.enabled && result.hotels.length > 0,
        utterance: said,
        parsed,
        parse,
        query,
        openai,
        timings: {
          parseMs,
          searchMs: result.trace.searchMs,
          rankMs: result.trace.rankMs,
          thumbnailMs: result.trace.thumbnailMs,
          affiliateMs,
          totalMs: parseMs + result.trace.totalMs + affiliateMs,
        },
        counts: {
          searchCalls: result.trace.searchCalls,
          candidateChars: result.trace.candidateChars,
          candidates: result.trace.candidates,
          picks: result.trace.picks,
          droppedUntrusted: result.trace.droppedUntrusted,
          droppedThumbnails: result.trace.droppedThumbnails,
          // 이미지가 실제로 붙었는지, 어느 층에서 건졌는지 (og / ld / photo)
          thumbnails: result.trace.thumbnails,
          thumbnailSources: result.trace.thumbnailSources,
          hotels: result.trace.hotels,
          // 커미션 링크로 바뀐 건수. fallback 이 0 이 아니면 그만큼 수익화가 안 된다.
          affiliateConverted: countConverted(result.hotels, links),
          affiliateFallback: result.hotels.length - countConverted(result.hotels, links),
        },
        hotels: result.hotels.map((h) => ({
          name: h.name,
          sourceUrl: h.sourceUrl,
          merchant: h.merchant,
          priceFrom: h.priceFrom,
          reviewScore: h.reviewScore,
          starRating: h.starRating,
          thumbnailUrl: h.thumbnailUrl,
          tags: h.tags,
          // 카카오 카드에 실제로 찍힐 문구. 40자 제한에 걸리는지 눈으로 확인.
          cardDescription: listDescription(h),
          affiliateUrl: links.get(h.sourceUrl)?.affiliateUrl ?? null,
          affiliateStatus: links.get(h.sourceUrl)?.status ?? null,
          // /r/{clickId} 가 실제로 보낼 곳. 원본과 같으면 커미션이 안 붙은 것이다.
          linkConverted: isConverted(h.sourceUrl, links),
        })),
        candidates: isTrue(candidates) ? result.candidates : null,
        hint: hintFor(
          openai.enabled,
          result.hotels.length,
          result.trace,
          result.hotels.length - countConverted(result.hotels, links),
        ),
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`debug search "${said}" failed err=${message}`);
      // 던지지 않는다. 실패 내용을 응답으로 봐야 하는 게 이 엔드포인트의 목적이다.
      // 파싱 결과는 살아 있다. 같이 버리면 "어디까지 갔다가 죽었는지"를 못 본다.
      return answer(
        // 스킬 컨트롤러가 예외를 삼키고 내보내는 것과 같은 말풍선.
        t.simpleText(
          '일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏',
          this.hotels.cityQuickReplies(),
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
                guests: parsed.guests,
                limit: this.config.hotelResultLimit,
              }
            : null,
          openai,
          timings: {
            parseMs,
            searchMs: 0,
            rankMs: 0,
            thumbnailMs: 0,
            affiliateMs: 0,
            totalMs: parseMs,
          },
          counts: null,
          hotels: [],
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
    if (token !== expected)
      throw new UnauthorizedException('invalid debug token');
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
  hotels: { sourceUrl: string }[],
  links: Map<string, ResolvedLink>,
): number {
  return hotels.filter((h) => isConverted(h.sourceUrl, links)).length;
}

/**
 * 앱이 실제로 들고 있는 키의 지문.
 *
 * 키 값은 절대 내보내지 않는다. 대신 **다른 환경에서 같은 방법으로 뽑아 대조할 수 있는**
 * 해시 앞자리와, 프로젝트 키인지(sk-proj-) 아닌지를 알려준다.
 *
 * 셸에서 같은 값을 뽑는 법:
 *   node -e "console.log(require('crypto').createHash('sha256').update(process.env.OPENAI_API_KEY).digest('hex').slice(0,12))"
 */
export function keyFingerprint(key: string): Record<string, unknown> {
  if (!key) return { present: false };
  return {
    present: true,
    // sk-proj- 로 시작하면 프로젝트 전용 키다. 프로젝트가 키에 박혀 있다는 뜻.
    prefix: key.slice(0, key.startsWith('sk-proj-') ? 8 : 3),
    length: key.length,
    sha256: createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12),
  };
}

/**
 * OpenAI 가 던진 에러를 "그래서 뭘 고쳐야 하는지"로 옮긴다.
 *
 * 원문만 보면 우리 코드 문제인지 계정 설정 문제인지 구분이 안 된다.
 * 대부분은 계정 쪽이고, 그건 배포로 해결되지 않는다.
 */
export function failureHint(message: string): string {
  if (/model_not_found|does not have access to model/i.test(message)) {
    const model = /model `([^`]+)`/.exec(message)?.[1];
    return (
      `이 키로는 ${model ? `\`${model}\` ` : '해당 모델을 '}쓸 수 없습니다. ` +
      '`/v1/models` 로는 보이는데 여기서 403 이라면 **두 호출이 다른 키를 쓰고 있는 것**입니다. ' +
      '응답의 openai.key.sha256 과, 셸에서 뽑은 값을 대조하세요: ' +
      'node -e "console.log(require(\'crypto\').createHash(\'sha256\')' +
      '.update(process.env.OPENAI_API_KEY).digest(\'hex\').slice(0,12))" — ' +
      '다르면 앱이 다른 .env 를 읽고 있거나 컨테이너가 옛 키로 떠 있는 것입니다(재배포 필요). ' +
      '같다면: openai.project 가 null 이고 키가 sk-proj- 가 아니면 조직 **기본 프로젝트**로 ' +
      '붙은 것이라, 대시보드에서 고친 프로젝트와 다를 수 있습니다 — OPENAI_PROJECT 에 ' +
      '에러에 찍힌 것 말고 **원하는** 프로젝트 ID 를 넣으세요. ' +
      '그것도 아니면 키 자체의 제한(Restricted key 의 허용 모델)이나 조직 인증 문제입니다.'
    );
  }
  if (/401|invalid_api_key|Incorrect API key/i.test(message)) {
    return 'OPENAI_API_KEY 가 잘못됐거나 폐기됐습니다.';
  }
  if (/429|rate.?limit|quota|insufficient_quota/i.test(message)) {
    return '요청 한도 또는 크레딧이 소진됐습니다. OpenAI 대시보드의 사용량·결제를 확인하세요.';
  }
  if (/timeout/i.test(message)) {
    return `검색이 ${'OPENAI_TIMEOUT_SECONDS'} 안에 안 끝났습니다. 값을 늘리거나 effort 를 낮추세요.`;
  }
  return `검색 중 예외가 났습니다: ${message.slice(0, 200)}`;
}

/**
 * 파싱이 도시를 못 준 이유를 사람 말로 옮긴다.
 *
 * "못 뽑았다"와 "물어보다 끊겼다"는 완전히 다른 문제인데, 예전에는 둘 다
 * "도시를 못 뽑았습니다" 로 나가서 원인 추적이 안 됐다.
 */
function parseHint(
  timedOut: boolean,
  error: string | null,
  timeoutMs: number,
): string {
  if (timedOut) {
    return (
      `발화 파싱이 ${timeoutMs}ms 안에 안 끝나 중단됐습니다. 도시를 못 알아들은 게 아닙니다. ` +
      'OPENAI_PARSE_TIMEOUT_SECONDS 를 늘리거나 OPENAI_PARSE_MODEL 을 더 빠른 모델(gpt-5-nano)로 바꾸세요.'
    );
  }
  if (error) return `발화 파싱이 실패했습니다: ${error}`;
  return '모델이 발화에서 도시를 찾지 못했습니다. 스킬에서는 되묻기가 나갑니다.';
}

/** 결과가 비었을 때 어디를 봐야 하는지 알려준다. 단계별로 원인이 다르다. */
function hintFor(
  enabled: boolean,
  hotels: number,
  trace: SearchTrace,
  affiliateFallback = 0,
): string | null {
  if (!enabled)
    return 'OPENAI_API_KEY 가 비어 있습니다. 검색을 아예 시도하지 않았습니다.';

  // 결과가 나와도 조용히 망가져 있을 수 있는 두 가지를 먼저 알려준다.
  if (hotels > 0) {
    const notes: string[] = [];
    if (affiliateFallback > 0) {
      notes.push(
        `${affiliateFallback}건이 애드픽 변환 없이 원본 주소로 나갑니다 — 그만큼 수익화가 안 됩니다. ` +
          'ADPICK_API_KEY 와 호텔별 affiliateStatus 를 확인하세요.',
      );
    }
    if (trace.thumbnails === 0) {
      notes.push(
        '이미지를 하나도 못 붙였습니다. 예약 페이지가 봇을 막았거나(403·429) ' +
          'HOTEL_THUMBNAILS 가 꺼져 있습니다. 서버 로그의 thumbnail 줄을 보세요.',
      );
    }
    return notes.length ? notes.join(' / ') : null;
  }

  if (trace.candidates === 0) {
    return (
      '1차 웹 검색이 후보를 하나도 못 모았습니다. candidates=true 로 원문을 확인하세요. ' +
      '모델이 결과 대신 되묻는 문장을 냈다면 OPENAI_MODEL 이 너무 작은 것입니다 ' +
      '(gpt-5-nano 는 web_search 를 제대로 못 씁니다 — 검색용은 gpt-5-mini 이상 권장).'
    );
  }
  if (!trace.searchCalls) {
    return 'web_search 가 한 번도 호출되지 않았습니다. 모델이 기억으로 답했으므로 URL 을 믿을 수 없습니다.';
  }
  if (trace.picks === 0) {
    return `후보 ${trace.candidates}개를 모았지만 2차 선별이 하나도 못 골랐습니다. 후보의 URL 을 확인하세요.`;
  }
  return `고른 ${trace.picks}개가 전부 허용 호스트 밖이라 버려졌습니다. ALLOWED_HOSTS 와 프롬프트를 확인하세요.`;
}

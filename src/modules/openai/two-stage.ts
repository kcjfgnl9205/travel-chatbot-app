import { Logger } from '@nestjs/common';

import { clip } from '../../common/parse';
import { AppConfig } from '../../config/app.config';
import { OpenAiService, parseJsonLoose } from './openai.service';

/**
 * 웹 검색 2단 파이프라인. 호텔·항공권·관광지 provider 가 공유한다.
 *
 *   1차 : web_search 를 돌려 후보 10~20개를 긁는다 (구조화 JSON)
 *   2차 : 후보에 번호를 붙여 보여주고 **번호만** 받는다 (구조화 JSON)
 *
 * **왜 두 번 부르나** — 한 번에 시키면 모델이 검색 결과를 요약하는 데 힘을 쓰고
 * 비교·선별은 대충 한다. 검색과 판단을 갈라두면 각 단계를 따로 계측·디버깅할 수 있다.
 *
 * ⚠️ **2차는 번호만 받는다. 항목을 다시 쓰게 하지 않는다.** 예전에는 고른 항목을
 *    통째로 다시 출력하게 했는데, 셋 다 나빴다 —
 *
 *      · **지어낸 URL 이 들어온다.** 모델이 주소를 다시 타이핑하는 순간 고칠 기회가
 *        생기고, provider 는 그걸 `dropped ... untrusted url` 로 버린다. 번호는
 *        지어낼 자리가 없다 — 범위 밖이면 그냥 무시된다.
 *      · **느리다.** 출력 토큰이 길어서 2차가 23~30초였다. 번호만 내면 짧아진다.
 *      · **빈손이 된다.** `RANK_EFFORT=minimal` 에서 모델이 `source_url` 에 빈
 *        문자열이나 "정보 없음" 을 채워, picks=10 인데 결과는 0건이 됐다.
 *
 *    그래서 **카드에 쓰는 값은 전부 1차 후보 스키마에 있어야 한다.** 2차가 채우던
 *    칸(호텔 주소·성급, 항공편 시각)은 애초에 웹 검색을 한 1차만 알 수 있던 것이고,
 *    2차는 그걸 지어내고 있었다.
 *
 * ⚠️ **두 호출 다 구조화 출력을 건다.** 1차를 자유 텍스트로 뒀더니 모델이
 *    "웹 검색을 진행해도 될까요? 날짜를 알려주세요" 라고 되묻고 끝나서 후보가 0개가 됐다.
 *    상대는 사람이 아니라 프로그램이라 그 질문에 답할 사람이 없다.
 *
 * ⚠️ 느리다(합쳐서 7~30초). 카카오 5초 예산 안에서 부르면 안 된다.
 *    도메인 서비스가 콜백/백그라운드에서만 호출한다.
 *
 * **여기 없는 것이 곧 도메인의 정체다.** 프롬프트·스키마·정규화·후처리(호텔 썸네일,
 * 관광지 사진)는 전부 provider 에 남아 있다. 이 클래스가 아는 건 "두 번 부르고 계측한다"
 * 뿐이다.
 */
export abstract class TwoStageSearch<TQuery> {
  protected abstract readonly logger: Logger;

  /** 로그에 찍는 도메인 이름. 'hotel' | 'flight' | 'attraction' */
  protected abstract readonly label: string;

  constructor(
    protected readonly config: AppConfig,
    protected readonly openai: OpenAiService,
  ) {}

  /** 키가 없으면 검색을 시도조차 하지 않는다. 호출부가 미리 알아야 한다. */
  get enabled(): boolean {
    return this.openai.enabled;
  }

  // ------------------------------------------------ 도메인이 채워야 하는 것
  /**
   * 로그에서 어느 검색인지 가리키는 조각. `city=오사카` / `route=인천(ICN) → 오사카(KIX)`
   *
   * `key=value` 꼴을 지킨다 — 로그를 grep 할 때 이게 곧 검색어가 된다.
   */
  protected abstract subjectOf(query: TQuery): string;

  protected abstract readonly searchInstructions: string;
  protected abstract readonly candidateSchema: Record<string, unknown>;
  /** @param wanted 모아 오라고 시킬 후보 개수 (OPENAI_CANDIDATE_COUNT). */
  protected abstract searchInput(query: TQuery, wanted: number): string;

  protected abstract readonly rankInstructions: string;
  /**
   * 번호를 붙인 후보 목록을 받아 2차 입력문을 만든다.
   *
   * ⚠️ **출력 형식은 여기서 말하지 마라.** 번호만 낸다는 규약은 모든 도메인이
   *    같아야 해서 [INDEX_RULES](#INDEX_RULES) 가 들고 있다. 도메인이 적을 것은
   *    "무엇을 기준으로 고르는가" 뿐이다.
   */
  protected abstract rankInput(query: TQuery, candidates: string): string;
  /** 몇 개를 고르게 할 것인가. 번호가 그보다 많이 와도 여기서 자른다. */
  protected abstract limitOf(query: TQuery): number;

  // -------------------------------------------------- 1차: 웹 검색으로 후보 수집
  /**
   * 후보를 모아 JSON 문자열로 돌려준다. 한 건도 못 모으면 null.
   *
   * null 을 받은 호출부는 **2차를 부르지 않고 바로 끝낸다.** 후보가 없으면 고를 것도
   * 없는데 한 번 더 부르면 모델이 빈손에서 뭔가를 지어낸다.
   */
  protected async findCandidates(query: TQuery, trace: TwoStageTrace): Promise<unknown[] | null> {
    const subject = this.subjectOf(query);

    const result = await this.openai.respond({
      instructions: this.searchInstructions,
      tools: [this.openai.webSearchToolSpec],
      // ⚠️ 검색을 **반드시** 돌린다. auto 로 두면 모델이 건너뛰고 빈 결과를 낸다.
      toolChoice: 'required',
      effort: this.config.openaiSearchEffort,
      format: this.candidateSchema,
      input: this.searchInput(query, this.config.openaiCandidateCount),
    });

    trace.searchMs = result.ms;
    trace.searchCalls = result.searchCalls;

    // 검색을 한 번도 안 돌았으면 모델이 기억으로 답한 것이다 — URL 과 가격이 특히 위험하다.
    if (!result.searchCalls) {
      this.logger.warn(`web_search 가 호출되지 않았다 ${subject}`);
    }

    const parsed = parseJsonLoose<{ candidates?: unknown[] }>(result.text);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    trace.candidates = candidates.length;

    this.logger.log(
      `${this.label} search ${subject} searches=${result.searchCalls} ` +
        `candidates=${candidates.length} chars=${result.text.length} ms=${result.ms}`,
    );

    if (!candidates.length) {
      // 스키마를 걸어뒀는데도 비어 오면 프롬프트가 안 먹은 것이다. 원문을 남긴다.
      this.logger.warn(
        `${this.label} search produced no candidates ${subject} text=${clip(result.text, 200)}`,
      );
      return null;
    }

    // ⚠️ **2차에 넘기기 전에 쓸 수 없는 후보를 뺀다.** 프롬프트로 "예약 링크는 네 곳
    //    중 하나" 라고 시켜도 1차는 아고다·부킹닷컴을 섞어 온다. 예전에는 그 오염된
    //    풀을 그대로 2차에 넘겨, 모델이 **버려질 후보 중에서 20곳을 고르고** 정규화가
    //    그중 18개를 버렸다 (운영에서 picks=20 kept=2). 2차 호출이 통째로 낭비되고,
    //    사용자는 두 줄짜리 카드를 받는다.
    const usable = this.usableCandidates(candidates);
    trace.usableCandidates = usable.length;

    if (usable.length !== candidates.length) {
      this.logger.warn(
        `${this.label} candidates filtered ${subject} ` +
          `${candidates.length} → ${usable.length} (쓸 수 없는 후보를 2차 전에 뺐다)`,
      );
    }
    if (!usable.length) {
      // 1차가 전부 못 쓰는 것만 물어왔다. 2차를 부르면 빈손에서 지어낸다 —
      // 후보가 0개일 때 부르지 않는 것과 같은 이유다.
      this.logger.warn(
        `${this.label} search produced no usable candidates ${subject} ` +
          `(${candidates.length}곳 전부 걸러졌다 — 1차 프롬프트나 허용 목록을 봐야 한다)`,
      );
      return null;
    }
    return usable;
  }

  /**
   * 2차에 넘길 만한 후보만 남긴다. **기본은 전부 통과**다.
   *
   * 도메인이 "이건 어차피 못 쓴다" 를 아는 경우에만 덮어쓴다 — 호텔은 허용 호스트
   * 밖의 예약 링크가 그렇다. 정규화 단계에도 같은 검사가 남아 있어야 한다. 여기는
   * **낭비를 줄이는 자리**이지 안전장치가 아니다 (2차가 범위 밖 번호를 줄 수 있고,
   * 이 훅을 안 덮어쓰는 도메인도 있다).
   */
  protected usableCandidates(candidates: unknown[]): unknown[] {
    return candidates;
  }

  // ------------------------------------------------ 2차: 비교 후 상위 N개 선정
  /**
   * 후보 안에서 고른 것들. 아무것도 못 고르면 빈 배열.
   *
   * ⚠️ **빈손일 때 1차 후보를 대신 내보내지 않는다.** 그러면 모델의 비교·선별이
   *    조용히 사라지는데, 로그 말고는 그 사실이 드러나는 자리가 없다. 비교를 그만둘
   *    거라면 2차 호출 자체를 없애는 결정으로 해야지, 실패 경로에 숨기면 안 된다.
   */
  protected async rank<TCandidate>(
    query: TQuery,
    candidates: unknown[],
    trace: TwoStageTrace,
  ): Promise<TCandidate[]> {
    const subject = this.subjectOf(query);

    const result = await this.openai.respond({
      // 도메인은 "무엇을 기준으로 고르나" 만 말한다. 출력 형식은 공통이다.
      instructions: [this.rankInstructions, INDEX_RULES].join(' '),
      effort: this.config.openaiRankEffort,
      format: PICK_INDEX_SCHEMA,
      input: this.rankInput(query, numbered(candidates)),
    });

    trace.rankMs = result.ms;

    const parsed = parseJsonLoose<{ picks?: unknown[] }>(result.text);
    const raw = Array.isArray(parsed?.picks) ? parsed.picks : [];
    if (!raw.length) {
      this.logger.warn(
        `${this.label} rank produced no picks ${subject} status=${result.status} ` +
          `text=${clip(result.text, 200)}`,
      );
      return [];
    }

    const limit = this.limitOf(query);
    const seen = new Set<number>();
    const chosen: TCandidate[] = [];
    /** 범위 밖이거나 숫자가 아닌 번호. 모델이 규약에서 벗어나고 있다는 신호다. */
    let invalid = 0;

    for (const value of raw) {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        invalid += 1;
        continue;
      }
      // 같은 번호를 두 번 담으면 카드에 같은 줄이 두 번 나간다.
      if (seen.has(index)) continue;
      seen.add(index);
      chosen.push(candidates[index] as TCandidate);
      if (chosen.length >= limit) break;
    }

    trace.picks = chosen.length;
    this.logger.log(
      `${this.label} rank ${subject} picks=${chosen.length}/${raw.length} ` +
        `invalid=${invalid} ms=${result.ms}`,
    );
    // ⚠️ 전부 범위 밖이면 2차가 번호를 "고른" 게 아니라 지어낸 것이다. 조용히 넘기면
    //    빈 카드의 원인을 1차에서 찾게 된다.
    if (invalid && !chosen.length) {
      this.logger.warn(
        `${this.label} rank 가 범위 밖 번호만 냈다 ${subject} ` +
          `candidates=${candidates.length} raw=${clip(JSON.stringify(raw), 120)}`,
      );
    }
    return chosen;
  }
}

/**
 * 2차 응답 스키마. **도메인과 무관하게 하나다** — 번호만 받기 때문이다.
 *
 * 도메인마다 pick 스키마를 들고 있을 때는 필드를 하나 고칠 때마다 세 곳을 맞춰야
 * 했고, 그중 하나가 1차 후보에 없는 필드를 요구하면 모델이 그 칸을 지어냈다.
 */
export const PICK_INDEX_SCHEMA = {
  type: 'json_schema' as const,
  name: 'picks',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['picks'],
    properties: {
      picks: {
        type: 'array',
        items: { type: 'integer' },
        description: '고른 후보의 번호. 추천하는 순서대로 담는다',
      },
    },
  },
};

/**
 * 번호 고르기 규약. **도메인이 바꿀 수 없다** — 출력 형식은 스키마와 한 몸이라,
 * 한쪽만 고치면 응답이 통째로 버려진다.
 */
const INDEX_RULES = [
  '출력은 고른 후보의 **번호 목록**뿐이다. 이름·URL·가격을 다시 쓰지 마라.',
  '번호는 후보 목록 맨 앞에 적힌 그 번호다. 목록에 없는 번호는 쓰지 마라.',
  '추천하는 순서대로 담고, 같은 번호를 두 번 담지 마라.',
].join(' ');

/**
 * 후보에 번호를 붙인다. `0) {"name":"호텔 A",...}` 한 줄에 하나.
 *
 * 한 줄에 하나씩 두는 게 중요하다 — 배열을 통째로 들여쓰기 하면 모델이 몇 번째
 * 객체인지 세다가 틀린다. 번호가 줄 맨 앞에 있으면 셀 일이 없다.
 */
function numbered(candidates: unknown[]): string {
  return candidates.map((c, i) => `${i}) ${JSON.stringify(c)}`).join('\n');
}

/**
 * 2단 검색 한 번에 대한 계측. 도메인 trace 가 이걸 확장한다.
 *
 * **읽는 쪽은 `POST /api/v1/debug/search` 의 `trace` 와 테스트다.** 응답에 실려야
 * 로그를 못 보는 사람도 "왜 빈손인가" 를 짚는다 — searchCalls=0 이면 모델이 검색을
 * 건너뛴 것이고, candidates=0 이면 검색 프롬프트가 안 먹은 것이고, picks 는 있는데
 * 카드가 비면 정규화가 버린 것이다. 셋은 고치는 곳이 전부 다르다.
 *
 * ⚠️ **그래서 읽는 사람이 없는 필드는 두지 않는다.** totalMs·candidateChars 처럼
 *    채우기만 하던 칸이 있었는데, 그런 칸은 나중에 증가를 멈춰도 아무도 모른다 —
 *    틀린 계측은 없는 계측보다 나쁘다. 필드를 늘릴 거면 읽는 쪽을 같이 만든다.
 */
export interface TwoStageTrace {
  searchMs: number;
  rankMs: number;
  /** 모델이 web_search 를 실제로 돌린 횟수. 0 이면 기억으로 답한 것이다. */
  searchCalls: number;
  /** 1차 호출이 모아온 후보 개수. 0 이면 검색 프롬프트가 안 먹은 것이다. */
  candidates: number;
  /**
   * 그중 **2차에 실제로 넘긴** 개수. `candidates` 보다 한참 작으면 1차가 못 쓰는 것을
   * 물어온 것이고, 그건 2차·정규화가 아니라 **1차 프롬프트나 허용 목록**의 문제다.
   */
  usableCandidates: number;
  /** 2차 호출이 고른 **유효한** 번호의 개수 (provider 의 정규화·필터 전). */
  picks: number;
}

/** 공통 필드를 0으로. 도메인 필드는 호출부가 덧붙인다. */
export function newTwoStageTrace(): TwoStageTrace {
  return { searchMs: 0, rankMs: 0, searchCalls: 0, candidates: 0, usableCandidates: 0, picks: 0 };
}

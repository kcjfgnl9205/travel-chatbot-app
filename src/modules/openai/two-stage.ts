import { Logger } from '@nestjs/common';

import { clip } from '../../common/parse';
import { AppConfig } from '../../config/app.config';
import { OpenAiService, parseJsonLoose } from './openai.service';

/**
 * 웹 검색 2단 파이프라인. 호텔·항공권·관광지 provider 가 공유한다.
 *
 *   1차 : web_search 를 돌려 후보 10~20개를 긁는다 (구조화 JSON)
 *   2차 : 후보 안에서 상위 N개를 골라 구조화 JSON 으로 뽑는다
 *
 * **왜 두 번 부르나** — 한 번에 시키면 모델이 검색 결과를 요약하는 데 힘을 쓰고
 * 비교·선별은 대충 한다. 검색과 판단을 갈라두면 각 단계를 따로 계측·디버깅할 수 있다.
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
  protected abstract readonly pickSchema: Record<string, unknown>;
  /** 2차 응답에서 배열이 담겨 오는 키. 'hotels' | 'flights' | 'attractions' */
  protected abstract readonly pickKey: string;
  protected abstract rankInput(query: TQuery, candidates: string): string;

  // -------------------------------------------------- 1차: 웹 검색으로 후보 수집
  /**
   * 후보를 모아 JSON 문자열로 돌려준다. 한 건도 못 모으면 null.
   *
   * null 을 받은 호출부는 **2차를 부르지 않고 바로 끝낸다.** 후보가 없으면 고를 것도
   * 없는데 한 번 더 부르면 모델이 빈손에서 뭔가를 지어낸다.
   */
  protected async findCandidates(query: TQuery, trace: TwoStageTrace): Promise<string | null> {
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
    trace.candidateChars = result.text.length;

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
    return JSON.stringify(candidates);
  }

  // ------------------------------------------------ 2차: 비교 후 상위 N개 선정
  /** 후보 안에서 고른 것들. 아무것도 못 고르면 빈 배열. */
  protected async rank<TPick>(
    query: TQuery,
    candidates: string,
    trace: TwoStageTrace,
  ): Promise<TPick[]> {
    const subject = this.subjectOf(query);

    const result = await this.openai.respond({
      instructions: this.rankInstructions,
      effort: this.config.openaiRankEffort,
      format: this.pickSchema,
      input: this.rankInput(query, candidates),
    });

    trace.rankMs = result.ms;

    const parsed = parseJsonLoose<Record<string, TPick[]>>(result.text);
    const picks = parsed?.[this.pickKey];
    if (!picks?.length) {
      this.logger.warn(
        `${this.label} rank produced no picks ${subject} status=${result.status} ` +
          `text=${clip(result.text, 200)}`,
      );
      return [];
    }

    this.logger.log(`${this.label} rank ${subject} picks=${picks.length} ms=${result.ms}`);
    trace.picks = picks.length;
    return picks;
  }
}

/**
 * 2단 검색 한 번에 대한 계측. 도메인 trace 가 이걸 확장한다.
 *
 * ⚠️ **지금 이 값을 읽는 코드가 없다.** 원래는 진단 엔드포인트
 *    (/api/v1/debug/{hotel,flight,attraction}-search)가 "어디서 몇 초가 녹았는지" 를
 *    보여주려고 모았는데, 그 컨트롤러들이 /debug/search 하나로 합쳐지면서 사라졌다.
 *    로그에 찍히는 건 여기 담긴 값이 아니라 respond() 의 반환값이다.
 *
 *    남겨둔 이유는 채우는 비용이 사실상 0이고, 진단 화면을 다시 붙일 때 계측 지점을
 *    처음부터 다시 찾는 게 훨씬 비싸기 때문이다. 정말 안 쓸 거면 세 trace 인터페이스와
 *    searchTraced() 를 통째로 지우는 게 맞다 — 반쯤 남겨두는 게 제일 나쁘다.
 */
export interface TwoStageTrace {
  searchMs: number;
  rankMs: number;
  totalMs: number;
  /** 모델이 web_search 를 실제로 돌린 횟수. 0 이면 기억으로 답한 것이다. */
  searchCalls: number;
  candidateChars: number;
  /** 1차 호출이 모아온 후보 개수. 0 이면 검색 프롬프트가 안 먹은 것이다. */
  candidates: number;
  /** 2차 호출이 고른 개수 (필터 전). */
  picks: number;
}

/** 공통 필드를 0으로. 도메인 필드는 호출부가 덧붙인다. */
export function newTwoStageTrace(): TwoStageTrace {
  return {
    searchMs: 0,
    rankMs: 0,
    totalMs: 0,
    searchCalls: 0,
    candidateChars: 0,
    candidates: 0,
    picks: 0,
  };
}

import { Inject, Injectable, Logger } from '@nestjs/common';

import { FetchTimeoutError, fetchWithTimeout } from '../../common/fetch';
import { AppConfig, CONFIG, openaiEnabled } from '../../config/app.config';

/**
 * OpenAI Responses API 클라이언트.
 *
 *   POST {base}/responses
 *   { "model": "gpt-5-mini", "instructions": "...", "input": "...",
 *     "tools": [{"type": "web_search"}], "reasoning": {"effort": "low"} }
 *
 * 애드픽 클라이언트와 같이 fetch 만 쓴다. SDK 를 넣지 않는 이유는 의존성 하나를
 * 아끼려는 것보다, 여기서 쓰는 게 엔드포인트 하나뿐이기 때문이다.
 *
 * ⚠️ 웹 검색이 붙은 호출은 5~20초가 걸린다. 카카오 5초 예산 안에서 부르면 안 된다.
 *    호출부(HotelService)는 반드시 콜백/백그라운드에서만 이걸 탄다.
 */

export interface ResponsesRequest {
  input: string;
  /** 이 호출에만 쓸 모델. 발화 파싱은 검색보다 가볍고 빨라야 해서 따로 준다. */
  model?: string;
  instructions?: string;
  /** 웹 검색을 붙이려면 [{ type: 'web_search' }]. */
  tools?: Record<string, unknown>[];
  /**
   * 툴을 **반드시** 쓰게 할지. 'required' 면 최소 한 번은 호출한다.
   *
   * ⚠️ 기본값('auto')으로 두면 모델이 검색을 건너뛰고 빈 결과를 낸다.
   *    실측: 같은 질의에 어떤 때는 웹을 20번 뒤지고(60초, 20건), 어떤 때는
   *    `searches=0 candidates=0 chars=17` 로 5초 만에 `{"candidates":[]}` 를 뱉었다.
   *    사용자에게는 "지금은 정리하지 못했어요" 로 보이는데 원인은 검색을 안 한 것이다.
   */
  toolChoice?: 'auto' | 'required';
  /** minimal | low | medium | high */
  effort?: string;
  /** 구조화 출력. { type: 'json_schema', name, schema, strict } */
  format?: Record<string, unknown>;
  maxOutputTokens?: number;
  /**
   * 응답에 같이 받을 것. 웹 검색이 **실제로 본 출처 URL** 을 받으려면
   * `['web_search_call.action.sources']`.
   *
   * ⚠️ `web_search_preview` 로 떨어진 뒤에는 보내지 않는다 — 그 툴은 이 항목을 모른다.
   */
  include?: string[];
  /**
   * 이 호출에만 적용할 타임아웃.
   *
   * 기본값(OPENAI_TIMEOUT_SECONDS)은 웹 검색용이라 60초다. 카카오 5초 예산 안에서
   * 도는 호출(발화 파싱)은 훨씬 짧게 끊어야 한다.
   */
  timeoutMs?: number;
}

export interface ResponsesResult {
  text: string;
  /** 모델이 실제로 웹 검색을 몇 번 돌았는지. 프롬프트가 먹었는지 확인용. */
  searchCalls: number;
  /**
   * **웹 검색이 실제로 가져온 페이지 주소.** 검색 결과(`action.sources`), 연 페이지
   * (`open_page`), 본문 인용(`url_citation`)을 합친 것이다.
   *
   * 모델이 JSON 에 적은 주소는 모델이 **타이핑한 값**이라 지어낼 수 있다. 이 목록은
   * 검색 도구가 돌려준 값이라 그렇지 않다 — 둘을 대조하는 것이 "실제 검색 결과만 쓴다"
   * 를 지키는 유일한 방법이다. 비어 있으면 대조할 수 없다는 뜻이다(툴이 안 줬다).
   */
  sources?: string[];
  status: string;
  ms: number;
}

/**
 * 응답에서 본문 텍스트를 꺼낸다.
 *
 * `output_text` 는 공식 SDK 가 만들어주는 편의 필드다. 우리는 원시 JSON 을 받으므로
 * output[] 을 직접 훑어야 한다. (일부 버전은 output_text 도 같이 주므로 있으면 쓴다)
 */
export function outputTextOf(body: unknown): string {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.output_text === 'string' && raw.output_text.trim()) {
    return raw.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of Array.isArray(raw.output) ? raw.output : []) {
    const node = item as Record<string, unknown>;
    if (node?.type !== 'message') continue;
    for (const chunk of Array.isArray(node.content) ? node.content : []) {
      const c = chunk as Record<string, unknown>;
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 요청 헤더.
 *
 * ⚠️ **OpenAI-Project 가 없으면 레거시 `sk-` 키는 조직의 기본 프로젝트로 붙는다.**
 * 대시보드에서 다른 프로젝트의 Allowed models 를 고쳐놨다면 그 설정이 안 먹고
 * "Project ... does not have access to model" 403 이 난다. 실제로 그렇게 막힌 적 있다.
 *
 * `sk-proj-` 키는 프로젝트가 키에 박혀 있으므로 이 헤더가 필요 없다.
 * (넣더라도 키의 프로젝트와 같아야 한다 — 다르면 거부된다)
 */
export function requestHeaders(config: AppConfig): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.openaiApiKey}`,
    'content-type': 'application/json',
  };
  if (config.openaiProject) headers['OpenAI-Project'] = config.openaiProject;
  if (config.openaiOrganization) {
    headers['OpenAI-Organization'] = config.openaiOrganization;
  }
  return headers;
}

/** 웹 검색 호출 횟수. output[] 안의 web_search_call 항목을 센다. */
export function searchCallsOf(body: unknown): number {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.output)) return 0;
  return raw.output.filter(
    (item) => (item as Record<string, unknown>)?.type === 'web_search_call',
  ).length;
}

/**
 * 웹 검색이 실제로 가져온 페이지 주소. 순서대로, 중복 없이.
 *
 *   output[].type === 'web_search_call'
 *     .action.sources[].url        검색 결과 (include 로 요청해야 온다)
 *     .action.url                  open_page · find 로 연 페이지
 *   output[].type === 'message'
 *     .content[].annotations[]     type === 'url_citation' 의 url
 *
 * ⚠️ **모양이 조금씩 달라도 견딘다.** 툴 버전마다 필드가 다르게 붙은 적이 있어서,
 *    모르는 모양은 조용히 건너뛴다 — 여기서 던지면 검색 하나가 통째로 죽는다.
 */
export function searchSourcesOf(body: unknown): string[] {
  const raw = (body ?? {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const add = (url: unknown): void => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) seen.add(url);
  };

  for (const item of Array.isArray(raw.output) ? raw.output : []) {
    const node = (item ?? {}) as Record<string, unknown>;
    if (node.type === 'web_search_call') {
      const action = (node.action ?? {}) as Record<string, unknown>;
      add(action.url);
      for (const source of Array.isArray(action.sources) ? action.sources : []) {
        add((source as Record<string, unknown>)?.url);
      }
    }
    if (node.type === 'message') {
      for (const chunk of Array.isArray(node.content) ? node.content : []) {
        const annotations = (chunk as Record<string, unknown>)?.annotations;
        for (const note of Array.isArray(annotations) ? annotations : []) {
          const n = note as Record<string, unknown>;
          if (n?.type === 'url_citation') add(n.url);
        }
      }
    }
  }
  return [...seen];
}

/**
 * ```json ... ``` 로 감싸 오거나 앞뒤에 설명을 붙여 오는 경우를 견딘다.
 * 구조화 출력을 쓰면 보통 순수 JSON 이 오지만, 폴백 경로에서는 그렇지 않다.
 */
export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) candidates.push(fenced[1]);

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 자격증명이 거부된 뒤 다시 찔러보기까지 기다리는 시간.
 *
 * **영영 막지 않는 이유**: 키를 고친 뒤 컨테이너 재시작을 강요하지 않기 위해서다.
 * **즉시 풀지 않는 이유**: 401 은 다시 시도해도 같은 답이라, 그동안의 호출은 돈과
 * 콜백 예산만 태운다 (웹 검색이 붙으면 한 번에 25초다).
 */
const CREDENTIAL_COOLDOWN_MS = 5 * 60 * 1000;

/** `/health` 가 읽는 값. 키가 **채워졌나**가 아니라 **먹히나**를 말한다. */
export type OpenAiStatus = 'ok' | 'no-key' | 'rejected';

/**
 * 자격증명 거부인가 (401·403).
 *
 * 다른 실패와 갈라야 하는 이유는 **사용자에게 할 말이 다르기 때문**이다. 모델 오류나
 * 타임아웃은 "잠시 뒤 다시" 가 맞지만, 키가 틀린 것은 고치기 전에는 몇 번을 물어도
 * 같은 결과다 — 기다리라고 하면 그 사이 같은 질문만 반복된다.
 */
export const isCredentialError = (err: unknown): boolean =>
  err instanceof OpenAiHttpError && (err.status === 401 || err.status === 403);

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);

  /** 자격증명이 거부된 시각과 코드. 한 번이라도 성공하면 지운다. */
  private credentialRejectedAt: number | null = null;
  private credentialHttpStatus = 0;

  /**
   * 웹 검색 툴 이름. 계정/모델에 따라 `web_search` 대신 `web_search_preview` 만
   * 받는 경우가 있어, 400 이 나면 한 번 갈아끼우고 그 뒤로는 기억한다.
   */
  private webSearchTool = 'web_search';

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /** 키·주소·모델이 **채워져 있나.** 그 값이 먹히는지는 모른다. */
  get configured(): boolean {
    return openaiEnabled(this.config);
  }

  /**
   * 지금 부를 수 있나. 호출부(TwoStageSearch.enabled → HotelService.ready)가 이걸 보고
   * **헛된 검색을 시작하지 않는다.**
   */
  get enabled(): boolean {
    return this.configured && !this.credentialRejected;
  }

  /** 자격증명이 거부된 상태인가. 쿨다운이 지나면 스스로 풀린다. */
  get credentialRejected(): boolean {
    if (this.credentialRejectedAt === null) return false;
    if (Date.now() - this.credentialRejectedAt < CREDENTIAL_COOLDOWN_MS) return true;
    // 쿨다운이 끝났다. 진짜 판정은 다음 호출이 내린다.
    this.credentialRejectedAt = null;
    return false;
  }

  /** `/health` 용. 거부 상태면 HTTP 코드까지 알려준다 (401 키 · 403 권한). */
  get status(): OpenAiStatus {
    if (!this.configured) return 'no-key';
    return this.credentialRejected ? 'rejected' : 'ok';
  }

  get credentialHttpCode(): number {
    return this.credentialRejected ? this.credentialHttpStatus : 0;
  }

  get webSearchToolSpec(): Record<string, unknown> {
    return { type: this.webSearchTool };
  }

  async respond(req: ResponsesRequest): Promise<ResponsesResult> {
    if (!this.configured) throw new Error('OPENAI_API_KEY 가 설정되지 않았습니다');
    if (this.credentialRejected) {
      throw new OpenAiHttpError(this.credentialHttpStatus, '자격증명이 거부된 상태다(쿨다운 중)');
    }

    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? this.config.openaiTimeoutMs;
    let body: unknown;
    try {
      body = await this.post(this.payload(req), timeoutMs);
    } catch (err) {
      // 툴 이름이 문제인 경우에만 한 번 더 시도한다. 그 외 400 은 그대로 던진다.
      if (!this.shouldRetryWithPreviewTool(err, req)) throw err;
      this.webSearchTool = 'web_search_preview';
      this.logger.warn("web_search 가 거부됐다. web_search_preview 로 전환한다");
      body = await this.post(
        this.payload({ ...req, tools: [this.webSearchToolSpec], include: undefined }),
        timeoutMs,
      );
    }

    // 여기까지 왔으면 자격증명은 먹힌다. 거부 기록이 남아 있으면 지운다.
    this.credentialRejectedAt = null;

    const raw = (body ?? {}) as Record<string, unknown>;
    const status = typeof raw.status === 'string' ? raw.status : 'unknown';
    const text = outputTextOf(body);

    // incomplete 는 보통 max_output_tokens 에 걸린 것이다. 잘린 JSON 이 오므로 알려준다.
    if (status === 'incomplete') {
      const reason = (raw.incomplete_details as Record<string, unknown> | undefined)?.reason;
      this.logger.warn(`openai response incomplete reason=${String(reason)}`);
    }

    return {
      text,
      searchCalls: searchCallsOf(body),
      sources: searchSourcesOf(body),
      status,
      ms: Date.now() - started,
    };
  }

  // ---------------------------------------------------------------- 내부
  private payload(req: ResponsesRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: req.model ?? this.config.openaiModel,
      input: req.input,
    };
    if (req.instructions) payload.instructions = req.instructions;
    if (req.tools?.length) {
      payload.tools = req.tools;
      if (req.toolChoice) payload.tool_choice = req.toolChoice;
    }
    if (req.effort) payload.reasoning = { effort: req.effort };
    if (req.format) payload.text = { format: req.format };
    if (req.maxOutputTokens) payload.max_output_tokens = req.maxOutputTokens;
    if (req.include?.length && this.webSearchTool === 'web_search') payload.include = req.include;
    return payload;
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const url = `${this.config.openaiApiBase.replace(/\/+$/, '')}/responses`;

    try {
      return await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: requestHeaders(this.config),
          body: JSON.stringify(payload),
        },
        timeoutMs,
        async (res) => {
          if (!res.ok) {
            const detail = this.redact((await res.text().catch(() => '')).slice(0, 500));
            throw new OpenAiHttpError(res.status, detail);
          }
          return res.json();
        },
      );
    } catch (err) {
      if (err instanceof OpenAiHttpError) {
        this.noteCredentialError(err);
        throw err;
      }
      // 어느 호출이 늦었는지 알아야 해서 'openai' 를 붙인다 — 이 메시지는 검색이
      // 빈손으로 끝난 이유를 추적할 때 로그에서 그대로 찾는 문자열이다.
      if (err instanceof FetchTimeoutError) throw new Error(`openai timeout after ${timeoutMs}ms`);
      throw new Error(this.redact(String(err instanceof Error ? err.message : err)));
    }
  }

  private shouldRetryWithPreviewTool(err: unknown, req: ResponsesRequest): boolean {
    if (this.webSearchTool !== 'web_search') return false;
    if (!req.tools?.some((t) => t.type === 'web_search')) return false;
    return err instanceof OpenAiHttpError && err.status === 400 && /web_search/.test(err.detail);
  }

  /**
   * 401·403 을 **상태로 남긴다.**
   *
   * 2026-11-04 에 `.env` 의 키가 꼬리가 붙은 채 저장돼 모든 호출이 401 이었는데,
   * `/health` 는 계속 `ok` 를 답했다 — 값이 비었는지만 봤기 때문이다. 그동안 사용자는
   * "잠시 뒤 다시 시도해 주세요" 를 받았고, 그건 고치기 전엔 영영 안 되는 안내였다.
   * 원인을 짚는 데 한참 걸렸다. 그 두 가지를 여기서 끊는다.
   */
  private noteCredentialError(err: OpenAiHttpError): void {
    if (!isCredentialError(err)) return;
    const first = this.credentialRejectedAt === null;
    this.credentialRejectedAt = Date.now();
    this.credentialHttpStatus = err.status;
    if (first) {
      this.logger.error(
        `OpenAI 자격증명 거부 (HTTP ${err.status}). ` +
          `${Math.round(CREDENTIAL_COOLDOWN_MS / 60000)}분간 호출을 멈추고 ` +
          '/health 의 openai 를 rejected 로 바꾼다. ' +
          'OPENAI_API_KEY 와 OPENAI_PROJECT/ORGANIZATION 을 확인하라.',
      );
    }
  }

  /** 키가 로그에 남으면 안 된다. 헤더로만 보내지만 에코되는 경우를 대비한다. */
  private redact(text: string): string {
    const key = this.config.openaiApiKey;
    return key ? text.split(key).join('***') : text;
  }
}

export class OpenAiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`openai HTTP ${status}: ${detail}`);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';

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

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);

  /**
   * 웹 검색 툴 이름. 계정/모델에 따라 `web_search` 대신 `web_search_preview` 만
   * 받는 경우가 있어, 400 이 나면 한 번 갈아끼우고 그 뒤로는 기억한다.
   */
  private webSearchTool = 'web_search';

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return openaiEnabled(this.config);
  }

  get webSearchToolSpec(): Record<string, unknown> {
    return { type: this.webSearchTool };
  }

  async respond(req: ResponsesRequest): Promise<ResponsesResult> {
    if (!this.enabled) throw new Error('OPENAI_API_KEY 가 설정되지 않았습니다');

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
        this.payload({ ...req, tools: [this.webSearchToolSpec] }),
        timeoutMs,
      );
    }

    const raw = (body ?? {}) as Record<string, unknown>;
    const status = typeof raw.status === 'string' ? raw.status : 'unknown';
    const text = outputTextOf(body);

    // incomplete 는 보통 max_output_tokens 에 걸린 것이다. 잘린 JSON 이 오므로 알려준다.
    if (status === 'incomplete') {
      const reason = (raw.incomplete_details as Record<string, unknown> | undefined)?.reason;
      this.logger.warn(`openai response incomplete reason=${String(reason)}`);
    }

    return { text, searchCalls: searchCallsOf(body), status, ms: Date.now() - started };
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
    return payload;
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const url = `${this.config.openaiApiBase.replace(/\/+$/, '')}/responses`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: requestHeaders(this.config),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = this.redact((await res.text().catch(() => '')).slice(0, 500));
        throw new OpenAiHttpError(res.status, detail);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof OpenAiHttpError) throw err;
      if (controller.signal.aborted) throw new Error(`openai timeout after ${timeoutMs}ms`);
      throw new Error(this.redact(String(err instanceof Error ? err.message : err)));
    } finally {
      clearTimeout(timer);
    }
  }

  private shouldRetryWithPreviewTool(err: unknown, req: ResponsesRequest): boolean {
    if (this.webSearchTool !== 'web_search') return false;
    if (!req.tools?.some((t) => t.type === 'web_search')) return false;
    return err instanceof OpenAiHttpError && err.status === 400 && /web_search/.test(err.detail);
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

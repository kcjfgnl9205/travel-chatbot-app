/**
 * 환경변수.
 *
 * 파이썬판(app/core/config.py)과 **변수 이름을 그대로 맞췄다.**
 * 같은 .env 파일로 양쪽 다 돌아가야 전환 중에 헷갈리지 않는다.
 */

export interface AppConfig {
  appEnv: string;
  logLevel: string;
  publicBaseUrl: string;

  supabaseUrl: string;
  supabaseServiceRoleKey: string;

  adpickApiBase: string;
  adpickApiKey: string;
  adpickTimeoutMs: number;
  adpickLinkonly: boolean;
  adpickMaxConcurrency: number;
  adpickLinkTemplate: string;
  adpickLinkTtlDays: number;
  adpickSubidParam: string;

  kakaoSkillToken: string;
  kakaoCallbackTimeoutMs: number;
  debugToken: string;

  openaiApiKey: string;
  openaiApiBase: string;
  openaiProject: string;
  openaiOrganization: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  openaiSearchEffort: string;
  openaiRankEffort: string;
  openaiCandidateCount: number;
  openaiParseModel: string;
  openaiParseEffort: string;
  openaiParseTimeoutMs: number;
  nluAliasTtlMinutes: number;

  hotelProvider: string;
  hotelResultLimit: number;
  searchCacheTtlMinutes: number;
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

export function loadConfig(): AppConfig {
  return {
    appEnv: str('APP_ENV', 'local'),
    logLevel: str('LOG_LEVEL', 'INFO'),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8000'),

    supabaseUrl: str('SUPABASE_URL'),
    supabaseServiceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),

    adpickApiBase: str('ADPICK_API_BASE', 'https://biz.adpick.co.kr'),
    adpickApiKey: str('ADPICK_API_KEY'),
    // 파이썬은 초 단위(ADPICK_TIMEOUT_SECONDS). 같은 값을 ms 로 환산해서 쓴다.
    adpickTimeoutMs: Math.round(num('ADPICK_TIMEOUT_SECONDS', 2) * 1000),
    adpickLinkonly: bool('ADPICK_LINKONLY', true),
    adpickMaxConcurrency: num('ADPICK_MAX_CONCURRENCY', 5),
    adpickLinkTemplate: str('ADPICK_LINK_TEMPLATE'),
    adpickLinkTtlDays: num('ADPICK_LINK_TTL_DAYS', 30),
    // 애드픽 커미션 링크는 임의 파라미터를 해석하지 않는다(p_data 가 그 역할). 기본 비활성.
    adpickSubidParam: str('ADPICK_SUBID_PARAM'),

    kakaoSkillToken: str('KAKAO_SKILL_TOKEN'),
    // 카카오는 콜백을 1분 안에 받는다. 그 안에 못 보내면 사용자는 아무것도 못 받는다.
    kakaoCallbackTimeoutMs: Math.round(num('KAKAO_CALLBACK_TIMEOUT_SECONDS', 10) * 1000),
    // 진단 엔드포인트(/api/v1/debug/*) 보호. 운영에서 비워두면 그 경로는 404 다.
    debugToken: str('DEBUG_TOKEN'),

    openaiApiKey: str('OPENAI_API_KEY'),
    openaiApiBase: str('OPENAI_API_BASE', 'https://api.openai.com/v1'),
    // 레거시 sk- 키는 조직의 **기본 프로젝트**로 붙는다. 다른 프로젝트에서 모델을
    // 허용해뒀다면 그 설정이 안 먹는다. 이 값을 채우면 그 프로젝트로 붙는다.
    // sk-proj- 키는 프로젝트가 키에 박혀 있으므로 비워두면 된다.
    openaiProject: str('OPENAI_PROJECT'),
    openaiOrganization: str('OPENAI_ORGANIZATION'),
    openaiModel: str('OPENAI_MODEL', 'gpt-5-mini'),
    // 웹 검색이 붙은 호출은 느리다. 5초 예산은 캐시가 지키고, 여긴 넉넉히 준다.
    openaiTimeoutMs: Math.round(num('OPENAI_TIMEOUT_SECONDS', 60) * 1000),
    // gpt-5 계열은 reasoning.effort 를 받는다: minimal | low | medium | high.
    // 올릴수록 결과가 좋아지지만 콜백 1분 예산을 잡아먹는다.
    openaiSearchEffort: str('OPENAI_SEARCH_EFFORT', 'low'),
    openaiRankEffort: str('OPENAI_RANK_EFFORT', 'low'),
    openaiCandidateCount: num('OPENAI_CANDIDATE_COUNT', 15),
    // 발화 파싱은 카카오 5초 예산 안에서 돈다. 생각을 시키면 안 된다.
    //
    // 검색용 모델과 분리한 이유: 검색은 품질이 중요하고 콜백 예산(1분)을 쓰지만,
    // 파싱은 "도시 이름 하나 뽑기"라 작은 모델로 충분하고 **속도가 곧 품질**이다.
    openaiParseModel: str('OPENAI_PARSE_MODEL', 'gpt-5-nano'),
    openaiParseEffort: str('OPENAI_PARSE_EFFORT', 'minimal'),
    // 2.5초는 너무 빡빡했다 — 실제 gpt-5 계열은 이 정도로는 못 끝낸다.
    // 넘기면 되묻기로 떨어지므로, 5초 예산이 허락하는 만큼은 기다려준다.
    openaiParseTimeoutMs: Math.round(num('OPENAI_PARSE_TIMEOUT_SECONDS', 4) * 1000),
    // 같은 문장을 두 번 파싱하지 않는다. 이게 없으면 매 메시지가 유료가 된다.
    nluAliasTtlMinutes: num('NLU_ALIAS_TTL_MINUTES', 1440),

    hotelProvider: str('HOTEL_PROVIDER', 'openai'),
    hotelResultLimit: num('HOTEL_RESULT_LIMIT', 5),
    searchCacheTtlMinutes: num('SEARCH_CACHE_TTL_MINUTES', 60),
  };
}

/** @deprecated database.config 의 isDatabaseEnabled 와 같다. 호출부 호환용. */
export { isDatabaseEnabled as dbEnabled } from './database.config';

export const adpickApiEnabled = (c: AppConfig): boolean =>
  Boolean(c.adpickApiKey && c.adpickApiBase);

/** 키가 없으면 AI provider 는 검색을 시도하지 않고 빈 결과를 준다. */
export const openaiEnabled = (c: AppConfig): boolean =>
  Boolean(c.openaiApiKey && c.openaiApiBase && c.openaiModel);

export const redirectUrl = (c: AppConfig, clickId: string): string =>
  `${c.publicBaseUrl.replace(/\/+$/, '')}/r/${clickId}`;

export const CONFIG = 'APP_CONFIG';

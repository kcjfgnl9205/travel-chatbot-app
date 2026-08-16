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

    hotelProvider: str('HOTEL_PROVIDER', 'static'),
    hotelResultLimit: num('HOTEL_RESULT_LIMIT', 5),
    searchCacheTtlMinutes: num('SEARCH_CACHE_TTL_MINUTES', 60),
  };
}

/** Supabase 자격증명이 없으면 no-op 모드로 돈다. */
export const dbEnabled = (c: AppConfig): boolean =>
  Boolean(c.supabaseUrl && c.supabaseServiceRoleKey);

export const adpickApiEnabled = (c: AppConfig): boolean =>
  Boolean(c.adpickApiKey && c.adpickApiBase);

export const redirectUrl = (c: AppConfig, clickId: string): string =>
  `${c.publicBaseUrl.replace(/\/+$/, '')}/r/${clickId}`;

export const CONFIG = 'APP_CONFIG';

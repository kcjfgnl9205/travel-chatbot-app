/**
 * Supabase 접속 설정.
 *
 * 값 자체는 app.config.ts 의 AppConfig 에 들어 있고, 여기서는
 * "DB 를 쓸 수 있는 상태인가"를 판단하는 규칙만 모은다.
 */
import { AppConfig } from './app.config';

/** 자격증명이 없으면 no-op 모드로 돈다 — 앱은 죽지 않고 DB 적재만 건너뛴다. */
export const isDatabaseEnabled = (c: AppConfig): boolean =>
  Boolean(c.supabaseUrl && c.supabaseServiceRoleKey);

/** 서버 전용 클라이언트라 세션을 들고 있을 필요가 없다. */
export const supabaseClientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** 0001_init.sql 이 만드는 테이블 전부. 헬스체크가 이 목록을 찌른다. */
export const EXPECTED_TABLES = [
  'users',
  'messages',
  'affiliate_links',
  'search_cache',
  'recommendations',
  'recommendation_items',
] as const;

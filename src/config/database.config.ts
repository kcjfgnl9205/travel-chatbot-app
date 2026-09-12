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

/**
 * **코드가 실제로 읽고 쓰는** 테이블 전부. 헬스체크가 이 목록을 찌른다.
 *
 * ⚠️ 마이그레이션은 배포 자동화에 포함돼 있지 않다(SQL Editor 에 손으로 붙여넣는다).
 *    그래서 "코드는 새 버전인데 스키마는 옛 버전" 이 언제든 생길 수 있고,
 *    그걸 가장 먼저 알려주는 자리가 여기다. 테이블을 추가하면 여기도 추가한다.
 *
 * search_cache(0001)는 뺐다 — 라우터 이후로는 읽지 않는다. 안 쓰는 테이블을 찌르면
 * 누가 지웠을 때 멀쩡한 서버가 고장으로 보고된다.
 */
export const EXPECTED_TABLES = [
  // 0001~0003
  'users',
  'messages',
  'affiliate_links',
  'recommendations',
  'recommendation_items',
  // 0004 — 라우터
  'places',
  'place_aliases',
  'search_results',
  'intent_cache',
] as const;

/** 어느 마이그레이션이 만드는 테이블인가. 힌트가 파일명을 정확히 짚기 위한 것. */
export const TABLES_BY_MIGRATION: Record<string, readonly string[]> = {
  '0001_init.sql': ['users', 'messages', 'affiliate_links', 'recommendations', 'recommendation_items'],
  '0004_router.sql': ['places', 'place_aliases', 'search_results', 'intent_cache'],
};

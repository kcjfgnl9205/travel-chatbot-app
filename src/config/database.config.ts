/**
 * MySQL 접속 설정.
 *
 * 값 자체는 app.config.ts 의 AppConfig 에 들어 있고, 여기서는
 * "DB 를 쓸 수 있는 상태인가"를 판단하는 규칙만 모은다.
 */
import { AppConfig } from './app.config';

/** 자격증명이 없으면 no-op 모드로 돈다 — 앱은 죽지 않고 DB 적재만 건너뛴다. */
export const isDatabaseEnabled = (c: AppConfig): boolean =>
  Boolean(c.mysqlHost && c.mysqlUser);

/** 스키마 디렉터리. 배포 스크립트가 이 안의 *.sql 을 번호순으로 적용한다. */
export const SCHEMA_FILE = 'db/mysql/0001_init.sql';

/**
 * **코드가 실제로 읽고 쓰는** 테이블 전부. 헬스체크가 이 목록을 찌른다.
 *
 * ⚠️ 스키마는 배포 때 자동 적용되지만(db/migrate.js), 그게 실패하거나 건너뛰어지면
 *    "코드는 새 버전인데 스키마는 옛 버전" 이 생길 수 있고,
 *    그걸 가장 먼저 알려주는 자리가 여기다. 테이블을 추가하면 여기도 추가한다.
 *
 * 0013 이 테이블 셋을 지웠다 — search_cache(0001, 0004 부터 아무도 안 읽었다)와
 * 노출 위성 테이블 둘(recommendation_item_hotels/flights, 값이 공통 테이블로 올라갔다).
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
  // 0009 — 관광지 목록. 0012 부터 노출·클릭 카운터도 여기 있어서, 이 테이블이 없으면
  // 관광지 카드도 `/a/{id}` 리다이렉트도 통째로 안 된다.
  'attractions',
] as const;

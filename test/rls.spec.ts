import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **모든 테이블에 RLS 가 켜져 있는가.**
 *
 * 서버는 service_role 키로만 접근하고, 그 키는 RLS 를 통과한다. 정책 없이 RLS 만
 * 켜두면 anon / authenticated 는 **전부 차단된다** — 그게 0001 이 정한 방식이다.
 *
 * ⚠️ 반대로 **안 켜면 그 테이블은 anon 키로 통째로 읽힌다.** 노출·클릭 기록과 사용자
 *    키가 들어 있는 DB 라 그건 사고다. 그리고 이건 코드가 아니라 SQL 파일의 누락이라
 *    타입 검사도 린트도 못 잡는다 — 실제로 attraction_places 에서 빠뜨렸고 Supabase
 *    편집기 경고로 발견했다.
 *
 * 그래서 마이그레이션 파일을 직접 읽어 대조한다. DB 없이 도는 테스트다.
 */
describe('모든 테이블에 RLS', () => {
  const dir = join(__dirname, '../supabase/migrations');
  const sql = readdirSync(dir)
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');

  const created = [
    ...sql.matchAll(/create table if not exists public\.(\w+)/g),
  ].map((m) => m[1]);
  const guarded = new Set(
    [...sql.matchAll(/alter table public\.(\w+)\s+enable row level security/g)].map((m) => m[1]),
  );

  it('생성한 테이블은 전부 RLS 가 켜져 있다', () => {
    expect([...new Set(created)].filter((t) => !guarded.has(t)).sort()).toEqual([]);
  });

  /** 테이블을 못 찾으면 정규식이 깨진 것이다 — 통과가 아니라 실패여야 한다. */
  it('테이블을 실제로 읽고 있다', () => {
    expect(created.length).toBeGreaterThan(10);
  });
});

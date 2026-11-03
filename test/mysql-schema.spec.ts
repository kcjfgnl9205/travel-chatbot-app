import { join } from 'node:path';

import { EXPECTED_TABLES } from '../src/config/database.config';
import { loadMigrations, splitStatements } from '../src/migrate';

/**
 * **스키마 파일이 코드와 맞는가.** DB 없이 SQL 파일을 직접 읽어 대조한다.
 *
 * 스키마는 배포 때 자동으로 적용되지만, 코드가 쓰는 테이블을 파일에서 빠뜨리면
 * 적용은 "성공" 하고 그 기능만 조용히 고장 난다. 타입 검사도 린트도 못 잡는다.
 */
describe('db/mysql 스키마', () => {
  const dir = join(__dirname, '../db/mysql');
  const migrations = loadMigrations(dir);
  const sql = migrations.map((m) => m.sql).join('\n');
  const created = [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);

  it('파일 이름이 번호순이다 (러너가 이 순서로 적용한다)', () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((m) => m.name)).toEqual([...migrations.map((m) => m.name)].sort());
  });

  it('코드가 읽고 쓰는 테이블이 전부 있다', () => {
    expect(EXPECTED_TABLES.filter((t) => !created.includes(t))).toEqual([]);
  });

  /** 기본 콜레이션(ai_ci)이면 'OSAKA' = 'osaka' 라서 다른 사용자가 한 행으로 합쳐질 수 있다. */
  it('모든 테이블이 글자 그대로 비교한다 (utf8mb4_0900_bin)', () => {
    const tables = sql.split(/create table if not exists /).slice(1);
    const loose = tables
      .filter((body) => !/collate = utf8mb4_0900_bin;/.test(body))
      .map((body) => body.split(/\s/)[0]);
    expect(loose).toEqual([]);
  });

  it('러너가 문장을 제대로 쪼갠다 — 주석을 버리고 create table 하나가 한 문장', () => {
    const statements = migrations.flatMap((m) => splitStatements(m.sql));
    expect(statements.filter((s) => /^create table/.test(s))).toHaveLength(created.length);
    expect(statements.some((s) => s.trimStart().startsWith('--'))).toBe(false);
    expect(statements.some((s) => s.endsWith(';'))).toBe(false);
  });
});

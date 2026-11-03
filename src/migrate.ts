/**
 * 스키마 마이그레이션 러너.
 *
 *   node dist/migrate            # 운영 — deploy/remote.sh 가 새 컨테이너를 띄우기 **전에** 부른다
 *   npx ts-node src/migrate.ts   # 로컬
 *
 * db/mysql/*.sql 을 **파일 이름 순서로** 적용하고, 적용한 파일을 `schema_migrations` 에
 * 남긴다. 이미 남은 파일은 건너뛴다.
 *
 * Supabase 시절에는 SQL Editor 에 손으로 붙여넣었고, 빠뜨리면 그 기능만 **조용히** 옛날
 * 동작으로 돌았다(0015 를 빠뜨리면 수수료가 안 붙는데 링크는 멀쩡히 열린다). 그래서
 * 배포가 직접 돌린다. 실패하면 배포가 멈추고 **돌던 컨테이너는 그대로 산다.**
 *
 * ⚠️ MySQL 은 DDL 을 트랜잭션으로 되돌리지 못한다. 파일 중간에서 실패하면 앞 문장은
 *    이미 적용돼 있다. 그래서 문장은 `if not exists` 처럼 **다시 돌려도 안전하게** 쓰고,
 *    실패한 파일은 기록하지 않아 다음 배포에서 처음부터 다시 돈다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Connection, RowDataPacket, createConnection } from 'mysql2/promise';

import { loadConfig } from './config/app.config';
import { isDatabaseEnabled } from './config/database.config';
import { MYSQL_POOL_DEFAULTS } from './modules/database/mysql.service';

/** 이미지 안에서는 /app/db/mysql, 저장소에서는 ./db/mysql. 둘 다 작업 디렉터리 기준이다. */
const DIR = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'db', 'mysql');

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * 파일 하나를 문장 단위로 쪼갠다. `;` 로 끝나는 줄에서 자르고 `--` 주석 줄은 버린다.
 *
 * ⚠️ 그래서 **문자열 안에 `;` + 줄바꿈을 쓰면 안 되고, 프로시저(DELIMITER)도 못 쓴다.**
 *    지금 스키마는 둘 다 필요 없다. 필요해지면 그때 파서를 바꾼다.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || (!current.length && !line.trim())) continue;
    current.push(line);
    if (/;\s*$/.test(line)) {
      statements.push(current.join('\n').trim().replace(/;$/, ''));
      current = [];
    }
  }
  const rest = current.join('\n').trim();
  if (rest) statements.push(rest);
  return statements;
}

/**
 * 아직 안 돈 파일을 적용한다. 몇 개 적용했는지 돌려준다.
 * 통합 테스트(mysql-repositories.spec.ts)가 같은 함수로 테스트 DB 를 만든다.
 */
export async function runMigrations(
  conn: Connection,
  dir = DIR,
  log: Pick<Console, 'log' | 'warn'> = console,
): Promise<number> {
  await conn.query("SET time_zone = '+00:00'");
  await conn.query(`
    create table if not exists schema_migrations (
        name       varchar(255) not null,
        checksum   char(64)     not null,
        applied_at datetime(3)  not null default current_timestamp(3),
        primary key (name)
    ) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin`);

  // 두 배포가 동시에 돌면 같은 파일을 두 번 적용한다. 이름 붙은 락으로 한 줄로 세운다.
  const [[lock]] = await conn.query<RowDataPacket[]>(
    "SELECT GET_LOCK('schema_migrations', 60) AS ok",
  );
  if (!lock?.ok) throw new Error('다른 마이그레이션이 60초 넘게 락을 쥐고 있다');

  try {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map<string, string>(rows.map((r) => [String(r.name), String(r.checksum)]));

    let ran = 0;
    for (const m of loadMigrations(dir)) {
      const seen = applied.get(m.name);
      if (seen) {
        // 적용된 파일을 고치면 운영에는 영영 안 들어간다. 막지는 않고 크게 알린다.
        if (seen !== m.checksum) {
          log.warn(
            `  ⚠️ ${m.name} 이 적용된 뒤에 바뀌었다. 바뀐 내용은 운영에 반영되지 않는다 — 새 번호 파일로 옮겨라.`,
          );
        }
        continue;
      }

      log.log(`  적용: ${m.name}`);
      for (const statement of splitStatements(m.sql)) {
        await conn.query(statement);
      }
      await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [
        m.name,
        m.checksum,
      ]);
      ran += 1;
    }
    log.log(ran ? `▸ 마이그레이션 ${ran}개 적용` : '▸ 마이그레이션 — 새로 적용할 것 없음');
    return ran;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('schema_migrations')").catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!isDatabaseEnabled(config)) {
    console.log('▸ 마이그레이션 생략 — MYSQL_HOST / MYSQL_USER 가 비어 있다 (no-op 모드)');
    return;
  }

  const conn = await createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    ...MYSQL_POOL_DEFAULTS,
    connectTimeout: 10_000,
  });

  try {
    await runMigrations(conn);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`▸ 마이그레이션 실패: ${err?.code ?? ''} ${err?.message ?? err}`);
    process.exit(1);
  });
}

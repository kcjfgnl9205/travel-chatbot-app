/**
 * Supabase → MySQL 데이터 복사 (한 번 쓰는 이전 스크립트).
 *
 *   npm run db:copy-from-supabase              # 복사
 *   npm run db:copy-from-supabase -- --check   # 양쪽 행 수만 비교
 *
 * 필요한 환경변수 (.env 에서 읽고, 명령줄 값이 이긴다):
 *   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY   읽을 쪽
 *   MYSQL_HOST · MYSQL_PORT · MYSQL_USER · MYSQL_PASSWORD · MYSQL_DATABASE   쓸 쪽
 *
 * HeatWave 는 VCN 안에만 있으므로 로컬에서는 앱 서버를 거치는 SSH 터널로 붙는다
 * (docs/MIGRATION-MYSQL.md).
 *
 * 설계
 * - **넣기만 한다.** 이미 있는 행(같은 PK)은 건드리지 않는다. 그래서 몇 번을 다시 돌려도
 *   안전하고, 앱을 MySQL 로 바꾼 직후 한 번 더 돌리면 그 사이 Supabase 에 쌓인 행만 따라온다.
 * - 칸 목록은 **MySQL 쪽 테이블에서 읽는다.** Supabase 에만 남은 옛 칸은 버리고,
 *   생성 컬럼(affiliate_links.source_url_hash)은 MySQL 이 계산한다.
 * - FK 검사를 끄고 넣는다. places.parent_id 처럼 자기 자신을 무는 테이블은 부모가
 *   더 큰 id 일 수 있어서 순서로 풀 수 없다.
 * - supabase-js 없이 PostgREST 를 fetch 로 직접 부른다. 이 스크립트 하나 때문에
 *   의존성을 남겨둘 이유가 없다.
 */
import { RowDataPacket, createConnection } from 'mysql2/promise';

import { loadConfig } from '../src/config/app.config';
import { MYSQL_POOL_DEFAULTS } from '../src/modules/database/mysql.service';

/** 복사 순서와 페이지를 넘길 정렬 키. 부모가 먼저다(FK 를 꺼도 읽기 좋게). */
const TABLES: [table: string, orderBy: string][] = [
  ['users', 'id'],
  ['places', 'id'],
  ['place_aliases', 'alias'],
  ['messages', 'id'],
  ['affiliate_links', 'id'],
  ['recommendations', 'id'],
  ['recommendation_items', 'id'],
  ['attractions', 'id'],
  ['search_results', 'cache_key'],
  ['intent_cache', 'utterance_hash'],
];

const PAGE = 1000; // Supabase 의 한 번 최대 행 수
const CHECK_ONLY = process.argv.includes('--check');

async function main(): Promise<void> {
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 비어 있다');

  const config = loadConfig();
  if (!config.mysqlHost || !config.mysqlUser) throw new Error('MYSQL_HOST / MYSQL_USER 가 비어 있다');

  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const rest = async (path: string, extra: Record<string, string> = {}) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: { ...headers, ...extra } });
    if (!res.ok) throw new Error(`supabase ${path} → ${res.status} ${await res.text()}`);
    return res;
  };
  const supabaseCount = async (table: string): Promise<number> => {
    const res = await rest(`${table}?select=*&limit=1`, { Prefer: 'count=exact' });
    return Number(res.headers.get('content-range')?.split('/')[1] ?? NaN);
  };

  const conn = await createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    ...MYSQL_POOL_DEFAULTS,
    connectTimeout: 10_000,
  });
  await conn.query("SET time_zone = '+00:00'");
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    console.log(CHECK_ONLY ? '▸ 행 수 비교' : `▸ Supabase → MySQL (${config.mysqlHost}/${config.mysqlDatabase})`);
    let mismatched = 0;

    for (const [table, orderBy] of TABLES) {
      const [cols] = await conn.query<RowDataPacket[]>(
        `SELECT column_name AS name, data_type AS type, extra
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ?
          ORDER BY ordinal_position`,
        [table],
      );
      if (!cols.length) throw new Error(`MySQL 에 ${table} 이 없다 — 먼저 npm run db:migrate`);
      const columns = cols
        .filter((c) => !/GENERATED/i.test(String(c.extra)))
        .map((c) => ({ name: String(c.name), type: String(c.type).toLowerCase() }));

      let inserted = 0;
      let read = 0;
      if (!CHECK_ONLY) {
        for (let offset = 0; ; offset += PAGE) {
          const res = await rest(
            `${table}?select=*&order=${orderBy}.asc&limit=${PAGE}&offset=${offset}`,
          );
          const rows = (await res.json()) as Record<string, unknown>[];
          if (!rows.length) break;
          read += rows.length;

          const present = columns.filter((c) => c.name in rows[0]);
          const tuple = `(${present.map(() => '?').join(', ')})`;
          const params = rows.flatMap((row) => present.map((c) => toMysql(row[c.name], c.type)));
          const key = present[0].name;
          const [result] = await conn.query<RowDataPacket[] & { affectedRows: number }>(
            `INSERT INTO \`${table}\` (${present.map((c) => `\`${c.name}\``).join(', ')})
             VALUES ${rows.map(() => tuple).join(', ')}
             ON DUPLICATE KEY UPDATE \`${key}\` = \`${key}\``,
            params,
          );
          inserted += result.affectedRows;
          if (rows.length < PAGE) break;
        }
      }

      const [[{ n }]] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
      const source = await supabaseCount(table);
      const same = Number(n) === source;
      if (!same) mismatched += 1;
      console.log(
        `  ${table.padEnd(22)} supabase ${String(source).padStart(7)} · mysql ${String(n).padStart(7)}` +
          (CHECK_ONLY ? '' : ` · 이번에 넣음 ${String(inserted).padStart(6)} / 읽음 ${read}`) +
          (same ? '' : '  ⚠️ 다름'),
      );
    }

    // auto_increment 는 명시한 id 를 넣으면 알아서 max+1 로 따라온다. 확인만 한다.
    console.log(
      mismatched
        ? `▸ ${mismatched}개 테이블 행 수가 다르다. 앱이 아직 Supabase 에 쓰는 중이면 정상이다 — 전환 뒤 다시 돌려라.`
        : '▸ 전 테이블 행 수 일치',
    );
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
    await conn.end();
  }
}

/** PostgREST 가 준 값을 MySQL 칸 타입에 맞춘다. */
function toMysql(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  // JSON 칸은 문자열이어도 JSON 으로 감싼다 ("abc" → '"abc"'). 객체는 그대로 넘기면 mysql2 가 펼친다.
  if (type === 'json') return JSON.stringify(value);
  // timestamptz 는 '2026-11-03T12:00:00.123456+00:00' 로 온다. Date 로 바꾸면 UTC 로 적힌다.
  if (type === 'datetime' || type === 'timestamp') return new Date(String(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

main().catch((err) => {
  console.error(`▸ 복사 실패: ${err?.code ?? ''} ${err?.message ?? err}`);
  process.exit(1);
});

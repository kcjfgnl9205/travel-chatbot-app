import { Logger } from '@nestjs/common';
import { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { MysqlService } from '../mysql.service';

/** 파라미터 하나. 배열은 `IN (?)` 에서 목록으로 펼쳐진다. */
export type Param = unknown;

/** SELECT 결과 행. 행 타입(rows.types.ts)을 넘겨 받는다. */
type Selected<T> = T & RowDataPacket;

/** 트랜잭션 안에서 쓰는 최소 인터페이스. */
export interface Tx {
  select<T>(sql: string, params?: Param[]): Promise<T[]>;
  execute(sql: string, params?: Param[]): Promise<ResultSetHeader>;
}

/**
 * 중복 키(유니크·PK)를 만났을 때.
 *
 * - `error`  : 그대로 실패한다 (plain insert).
 * - `ignore` : 있던 행을 그대로 둔다. ⚠️ `INSERT IGNORE` 를 쓰지 않는다 — 그건 중복만이
 *              아니라 FK 위반·길이 초과까지 경고로 삼켜서 "남이 먼저 넣었다" 와 구분이
 *              안 된다. 대신 `on duplicate key update <pk> = <pk>` 로 중복만 무시한다.
 * - `{ update }` : 주어진 칸을 새 값으로 덮어쓴다 (PostgREST upsert 와 같다).
 */
export type OnDuplicate = 'error' | 'ignore' | { update: string[] };

/**
 * 테이블 하나에 대한 얇은 래퍼.
 *
 * 모든 쿼리는 실패해도 예외를 올리지 않는다. 로깅 실패 때문에
 * 사용자가 호텔 목록을 못 받는 상황을 만들지 않기 위해서다.
 * 실패는 `null`, "결과 없음" 은 빈 배열 — 둘은 다르다(search_results.claim 참고).
 */
export abstract class BaseRepository {
  protected abstract readonly tableName: string;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly db: MysqlService) {}

  get enabled(): boolean {
    return this.db.enabled;
  }

  protected pool(): Pool | null {
    return this.db.getPool();
  }

  protected async select<T>(sql: string, params: Param[] = [], op = 'select'): Promise<T[] | null> {
    const pool = this.pool();
    if (!pool) return null;
    try {
      const [rows] = await pool.query<Selected<T>[]>(sql, params);
      return rows;
    } catch (err) {
      this.logFailure(op, err);
      return null;
    }
  }

  protected async selectOne<T>(sql: string, params: Param[] = [], op = 'select'): Promise<T | null> {
    const rows = await this.select<T>(sql, params, op);
    return rows && rows.length ? rows[0] : null;
  }

  /** INSERT / UPDATE / DELETE. 실패하면 null, 성공하면 영향받은 행 수가 든 헤더. */
  protected async execute(sql: string, params: Param[] = [], op = 'execute'): Promise<ResultSetHeader | null> {
    const pool = this.pool();
    if (!pool) return null;
    try {
      const [result] = await pool.query<ResultSetHeader>(sql, params);
      return result;
    } catch (err) {
      this.logFailure(op, err);
      return null;
    }
  }

  /**
   * 여러 문장을 한 트랜잭션으로. 콜백이 던지면 되돌리고 null.
   *
   * MySQL 에는 `update ... returning` 이 없어서 "카운터를 올리고 그 값을 돌려준다" 를
   * UPDATE → SELECT 두 문장으로 쓴다. UPDATE 가 잡은 행 잠금이 커밋까지 가므로
   * 사이에 다른 클릭이 끼어들어 숫자가 섞이지 않는다.
   */
  protected async transaction<T>(op: string, fn: (tx: Tx) => Promise<T>): Promise<T | null> {
    const pool = this.pool();
    if (!pool) return null;
    let conn: PoolConnection | null = null;
    try {
      conn = await pool.getConnection();
      const c = conn;
      await c.beginTransaction();
      const tx: Tx = {
        select: async <R>(sql: string, params: Param[] = []) =>
          (await c.query<Selected<R>[]>(sql, params))[0],
        execute: async (sql, params = []) => (await c.query<ResultSetHeader>(sql, params))[0],
      };
      const result = await fn(tx);
      await c.commit();
      return result;
    } catch (err) {
      await conn?.rollback().catch(() => undefined);
      this.logFailure(op, err);
      return null;
    } finally {
      conn?.release();
    }
  }

  /**
   * 여러 행 INSERT 문을 만든다. 칸 순서는 첫 행 기준이고, 어떤 행에 없는 칸은 DEFAULT.
   * 값은 {@link toDb} 로 바꿔 넣는다.
   */
  protected insertSql(
    rows: Record<string, unknown>[],
    onDuplicate: OnDuplicate = 'error',
    table = this.tableName,
  ): { sql: string; params: Param[] } {
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const params: Param[] = [];
    const tuples = rows.map((row) => {
      const slots = columns.map((col) => {
        if (!(col in row) || row[col] === undefined) return 'DEFAULT';
        params.push(toDb(row[col]));
        return '?';
      });
      return `(${slots.join(', ')})`;
    });

    let sql = `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES ${tuples.join(', ')}`;
    if (onDuplicate === 'ignore') {
      const key = columns[0];
      sql += ` ON DUPLICATE KEY UPDATE ${q(key)} = ${q(key)}`;
    } else if (onDuplicate !== 'error') {
      sql += ` AS new ON DUPLICATE KEY UPDATE ${onDuplicate.update
        .map((col) => `${q(col)} = new.${q(col)}`)
        .join(', ')}`;
    }
    return { sql, params };
  }

  /** `SET a = ?, b = ?` 조각. undefined 칸은 건너뛴다(= 안 건드림). */
  protected setSql(patch: Record<string, unknown>): { sql: string; params: Param[] } {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    return {
      sql: entries.map(([col]) => `${q(col)} = ?`).join(', '),
      params: entries.map(([, v]) => toDb(v)),
    };
  }

  private logFailure(op: string, err: unknown): void {
    const code = (err as { code?: string })?.code;
    const message = (err as Error)?.message ?? String(err);
    this.logger.warn(`mysql ${op} failed on ${this.tableName}: ${code ? `${code} ` : ''}${message}`);
  }
}

/** 식별자 인용. `rank` 처럼 예약어인 컬럼이 있어서 전부 감싼다. */
export const q = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * 쓰는 값을 MySQL 이 받는 모양으로.
 *
 * - ISO 문자열(`...Z`) → Date. 호출부가 `new Date().toISOString()` 으로 넘기는데,
 *   MySQL 8.0 은 끝의 `Z` 를 못 읽는다. Date 로 넘기면 mysql2 가 UTC 로 적는다.
 * - 객체·배열 → JSON 문자열. 그대로 넘기면 mysql2 가 `a = 1, b = 2` 로 펼쳐 버린다.
 */
export function toDb(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (typeof value === 'string' && ISO_UTC.test(value)) return new Date(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

import { Injectable } from '@nestjs/common';

import { MysqlService } from '../mysql.service';
import { BaseRepository, q } from './base.repository';

/** 비우기 결과. 중간에 실패해도 **어디까지 비웠는지**는 알려준다. */
export interface TruncateOutcome {
  /** 실제로 비운 테이블. 주어진 순서대로다. */
  cleared: string[];
  /** 거기서 멈춘 이유. 끝까지 갔으면 null. */
  failed: { table: string; message: string } | null;
}

/**
 * 운영 정비용 테이블 비우기 (`POST /api/v1/admin/reset`).
 *
 * **이 레포지토리만 테이블을 가로지른다.** 나머지는 테이블 하나씩 맡는데, 비우기는
 * 순서와 세션 설정이 테이블 전체에 걸쳐 있어서 한 곳에 모아야 한다.
 *
 * ⚠️ **테이블 이름은 호출부의 모듈 상수만 받는다.** 식별자는 바인딩할 수 없어 SQL 에
 *    직접 박히므로({@link q} 로 인용만 한다), 요청 본문에서 온 값을 여기로 흘리면
 *    그대로 SQL 주입이 된다. 지금은 [maintenance.service.ts] 의 `as const` 배열
 *    두 개가 유일한 출처다.
 */
@Injectable()
export class MaintenanceRepository extends BaseRepository {
  // BaseRepository 는 테이블 하나를 가정한다. 여기서는 실패 로그에 찍히는 이름일 뿐이다.
  protected readonly tableName = '(maintenance)';

  constructor(db: MysqlService) {
    super(db);
  }

  /** DB 가 잡혀 있나. 꺼져 있으면 비우기는 **조용히 성공한 척하면 안 된다.** */
  get available(): boolean {
    return this.pool() !== null;
  }

  /**
   * 테이블별 행 수. DB 를 못 쓰면 null.
   *
   * **한 왕복으로 센다.** 테이블마다 따로 물으면 11번 왕복이고, 프록시 타임아웃
   * (100초) 안에 끝나긴 해도 미리보기 하나에 그만큼 쓸 이유가 없다.
   *
   * ⚠️ `COUNT(*)` 는 InnoDB 에서 전체 훑기다. 로그 테이블이 수백만 행이면 몇 초
   *    걸린다 — 근삿값(`information_schema.TABLES.TABLE_ROWS`)을 쓰지 않는 건,
   *    "몇 행이 지워지는가" 를 보고 지울지 정하는 화면에서 근삿값은 쓸모가 없기
   *    때문이다.
   */
  async countRows(tables: readonly string[]): Promise<Record<string, number> | null> {
    if (!tables.length) return {};
    const sql = tables.map((t) => `SELECT ? AS tbl, COUNT(*) AS n FROM ${q(t)}`).join(' UNION ALL ');
    const rows = await this.select<{ tbl: string; n: number }>(sql, [...tables], 'count rows');
    if (!rows) return null;
    return Object.fromEntries(rows.map((r) => [r.tbl, Number(r.n)]));
  }

  /**
   * 주어진 순서대로 테이블을 비운다. DB 를 못 쓰면 null.
   *
   * **커넥션 하나에 고정해서 돈다.** `foreign_key_checks` 는 세션 변수라, 풀에서
   * 매번 다른 커넥션을 집으면 끈 쪽과 TRUNCATE 하는 쪽이 갈려 아무 효과가 없다.
   *
   * ⚠️ **FK 검사를 끄지 않으면 TRUNCATE 가 거절당한다.** MySQL 은 *다른 테이블이
   *    참조하는* 테이블을 TRUNCATE 하지 못한다 — 참조하는 쪽이 이미 비어 있어도
   *    마찬가지다. `users` 를 `messages`·`recommendations` 가, `recommendations` 를
   *    `recommendation_items` 가 물고 있어서 자식부터 지워도 풀리지 않는다.
   *
   * ⚠️ **TRUNCATE 는 되돌릴 수 없다.** DDL 이라 문장마다 암묵적 커밋이 일어난다 —
   *    트랜잭션으로 감싸도 중간에서 실패하면 앞 테이블은 이미 비어 있다. 그래서
   *    되돌리는 대신 **어디까지 갔는지 돌려준다.** 다시 불러도 안전하다(이미 빈
   *    테이블을 또 비울 뿐이다).
   */
  async truncate(tables: readonly string[]): Promise<TruncateOutcome | null> {
    const pool = this.pool();
    if (!pool) return null;

    const conn = await pool.getConnection();
    const cleared: string[] = [];
    try {
      await conn.query('SET SESSION foreign_key_checks = 0');
      for (const table of tables) {
        await conn.query(`TRUNCATE TABLE ${q(table)}`);
        cleared.push(table);
      }
      return { cleared, failed: null };
    } catch (err) {
      const table = tables[cleared.length] ?? '(unknown)';
      const message = (err as Error)?.message ?? String(err);
      this.logger.error(`truncate ${table} failed after ${cleared.length} tables: ${message}`);
      return { cleared, failed: { table, message } };
    } finally {
      // ⚠️ **끈 채로 풀에 돌려보내면 그 커넥션을 집는 모든 요청이 FK 검사 없이 돈다.**
      //    복구에 실패한 커넥션은 재사용하지 않고 버린다 — 풀이 하나 새로 열 뿐이다.
      let healthy = true;
      try {
        await conn.query('SET SESSION foreign_key_checks = 1');
      } catch (err) {
        healthy = false;
        this.logger.error(`foreign_key_checks 복구 실패 — 커넥션을 버린다: ${err}`);
      }
      if (healthy) conn.release();
      else conn.destroy();
    }
  }
}

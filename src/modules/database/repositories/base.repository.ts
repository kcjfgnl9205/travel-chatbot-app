import { Logger } from '@nestjs/common';
import { PostgrestSingleResponse, SupabaseClient } from '@supabase/supabase-js';

import { SupabaseService } from '../supabase.service';

type Row = Record<string, any>;
type Builder<T> = PromiseLike<PostgrestSingleResponse<T>>;

/**
 * Supabase 테이블 하나에 대한 얇은 래퍼.
 *
 * 모든 쿼리는 실패해도 예외를 올리지 않는다. 로깅 실패 때문에
 * 사용자가 호텔 목록을 못 받는 상황을 만들지 않기 위해서다.
 */
export abstract class BaseRepository {
  protected abstract readonly tableName: string;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly supabase: SupabaseService) {}

  get enabled(): boolean {
    return this.supabase.enabled;
  }

  protected client(): SupabaseClient | null {
    return this.supabase.getClient();
  }

  protected table(name?: string) {
    const client = this.client();
    if (!client) return null;
    return client.from(name ?? this.tableName);
  }

  /**
   * 쿼리를 지연 평가한다. client 가 null(no-op 모드)일 때 콜백을 아예 호출하지 않기 위해서.
   */
  protected async run<T = Row[]>(
    build: (table: NonNullable<ReturnType<BaseRepository['table']>>) => Builder<T>,
    op = 'query',
  ): Promise<Row[] | null> {
    const table = this.table();
    if (!table) return null;

    try {
      const { data, error } = await build(table);
      if (error) {
        this.logger.warn(`supabase ${op} failed on ${this.tableName}: ${error.message}`);
        return null;
      }
      if (data === null || data === undefined) return [];
      return Array.isArray(data) ? (data as Row[]) : [data as Row];
    } catch (err) {
      this.logger.warn(`supabase ${op} threw on ${this.tableName}: ${err}`);
      return null;
    }
  }

  protected async runOne<T = Row[]>(
    build: (table: NonNullable<ReturnType<BaseRepository['table']>>) => Builder<T>,
    op = 'query',
  ): Promise<Row | null> {
    const rows = await this.run(build, op);
    return rows && rows.length ? rows[0] : null;
  }

  /**
   * Postgres 함수 호출.
   *
   * PostgREST 로는 `set x = x + 1` 같은 표현식 업데이트를 못 한다.
   * 원자적 증가가 필요하면 함수를 만들어 여기로 부른다.
   */
  protected async rpc(
    fn: string,
    params: Record<string, unknown>,
    op = 'rpc',
  ): Promise<Row[] | null> {
    const client = this.client();
    if (!client) return null;

    try {
      const { data, error } = await client.rpc(fn, params);
      if (error) {
        this.logger.warn(`supabase ${op} failed on ${fn}: ${error.message}`);
        return null;
      }
      if (data === null || data === undefined) return [];
      return Array.isArray(data) ? (data as Row[]) : [data as Row];
    } catch (err) {
      this.logger.warn(`supabase ${op} threw on ${fn}: ${err}`);
      return null;
    }
  }
}

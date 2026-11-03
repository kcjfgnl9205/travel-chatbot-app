import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolOptions, createPool } from 'mysql2/promise';

import { AppConfig, CONFIG, dbEnabled } from '../../config/app.config';

/**
 * MySQL(OCI HeatWave) 커넥션 풀.
 *
 * 설계 원칙 2가지 (Supabase 시절과 같다)
 * 1. **접속 정보가 없으면 null 을 돌려주고 앱은 그대로 동작한다.** (no-op 모드)
 *    로컬에서 카카오 응답 JSON만 확인할 때 DB 없이 띄울 수 있어야 하므로.
 * 2. **DB 오류가 챗봇 응답을 죽이면 안 된다.** 로깅은 부가 기능이지 본 기능이 아니다.
 *    그래서 repository 들은 실패 시 예외 대신 null 을 돌려준다.
 */
@Injectable()
export class MysqlService implements OnModuleDestroy {
  private readonly logger = new Logger(MysqlService.name);
  private pool: Pool | null = null;
  private initFailed = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  getPool(): Pool | null {
    if (!dbEnabled(this.config) || this.initFailed) return null;
    if (this.pool) return this.pool;

    try {
      this.pool = createPool({
        host: this.config.mysqlHost,
        port: this.config.mysqlPort,
        user: this.config.mysqlUser,
        password: this.config.mysqlPassword,
        database: this.config.mysqlDatabase,
        connectionLimit: this.config.mysqlPoolSize,
        ...MYSQL_POOL_DEFAULTS,
      });
      // CURRENT_TIMESTAMP 기본값이 세션 시간대를 따른다. 서버 설정과 상관없이 UTC 로 고정.
      this.pool.pool.on('connection', (conn) => {
        conn.query("SET time_zone = '+00:00'");
      });
      this.logger.log(`mysql pool ready host=${this.config.mysqlHost}`);
    } catch (err) {
      this.initFailed = true;
      this.logger.error(`mysql pool init failed; running without DB: ${err}`);
      return null;
    }
    return this.pool;
  }

  get enabled(): boolean {
    return this.getPool() !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }

  /** 테스트용. */
  reset(): void {
    this.pool = null;
    this.initFailed = false;
  }
}

interface CastField {
  type: string;
  length: number;
  string(): string | null;
}

/**
 * 읽은 값을 Supabase(PostgREST) 시절과 **같은 모양**으로 돌려준다.
 * 레포지토리 위쪽 코드는 이 모양에 기대고 있다.
 *
 * - DATETIME → ISO 문자열(`...Z`). ⚠️ Date 객체로 두면 `String(row.updated_at)` 이
 *   밀리초를 잃고, search_results 낙관적 락(updated_at 비교)이 영영 안 맞는다.
 * - DECIMAL → number. (mysql2 기본은 문자열)
 * - BOOLEAN(TINYINT(1)) → boolean.
 */
export function typeCast(field: CastField, next: () => unknown): unknown {
  if (field.type === 'DATETIME' || field.type === 'TIMESTAMP') {
    const raw = field.string();
    return raw ? `${raw.replace(' ', 'T')}${raw.includes('.') ? '' : '.000'}Z` : null;
  }
  if (field.type === 'NEWDECIMAL') {
    const raw = field.string();
    return raw === null ? null : Number(raw);
  }
  if (field.type === 'TINY' && field.length === 1) {
    const raw = field.string();
    return raw === null ? null : raw === '1';
  }
  return next();
}

/** 앱과 통합 테스트가 같은 풀 설정을 쓰도록 모아둔다. */
export const MYSQL_POOL_DEFAULTS: PoolOptions = {
  charset: 'utf8mb4',
  // JS Date ↔ DATETIME 을 UTC 로 직렬화한다. 서버 쪽은 위의 time_zone 으로 맞춘다.
  timezone: 'Z',
  // ⚠️ **FOUND_ROWS 를 끈다.** mysql2 는 기본으로 켜는데, 켜져 있으면
  //    `on duplicate key update x = x`(= 중복이면 무시)가 **새로 넣은 것과 같은 1**을
  //    돌려준다. search_results 선점 판정이 그 숫자 하나에 기대고 있다.
  flags: ['-FOUND_ROWS'],
  supportBigNumbers: true,
  enableKeepAlive: true,
  typeCast,
};

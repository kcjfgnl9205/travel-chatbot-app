import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { AppConfig, CONFIG, adpickApiEnabled, dbEnabled, openaiEnabled } from '../../config/app.config';
import { AttractionService } from '../attraction/attraction.service';
import { FlightService } from '../flight/flight.service';
import { HotelService } from '../hotel/hotel.service';
import { EXPECTED_TABLES, SCHEMA_FILE } from '../../config/database.config';
import { MysqlService } from '../database/mysql.service';

/**
 * 헬스체크. 두 개로 나눈 이유:
 *
 *   /health     앱이 살아있나 (liveness). Caddy·compose 가 30초마다 두드린다.
 *               DB 를 건드리지 않는다 — DB 가 잠깐 흔들렸다고 컨테이너가 재시작되면 안 된다.
 *
 *   /health/db  MySQL 접속 정보가 **실제로 먹는가** (진단용).
 *               환경변수가 채워졌는지가 아니라 진짜 쿼리를 날려본다.
 */

type ProbeResult = true | string;

@ApiTags('운영')
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly mysql: MysqlService,
    private readonly hotels: HotelService,
    private readonly flights: FlightService,
    private readonly attractions: AttractionService,
  ) {}

  /** 앱 생존 확인. DB 는 건드리지 않는다. */
  @Get('health')
  @ApiOperation({
    summary: '앱 생존 확인 (liveness)',
    description: 'DB 를 건드리지 않는다. DB 가 잠깐 흔들렸다고 컨테이너가 재시작되면 안 되기 때문.',
  })
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      env: this.config.appEnv,
      db: dbEnabled(this.config) ? 'mysql' : 'disabled(no-op)',
      // ⚠️ 설정값이 아니라 **실제로 주입된 provider** 를 찍는다. 예전에는
      //    HOTEL_PROVIDER 를 그대로 보여줬는데, 그 값은 아무도 읽지 않아서
      //    .env 에 static 이라고 적어두면 OpenAI 를 부르면서 static 이라고 보고했다.
      providers: {
        hotel: this.hotels.providerName,
        flight: this.flights.providerName,
        attraction: this.attractions.providerName,
      },
      openai: openaiEnabled(this.config) ? this.config.openaiModel : 'disabled(no key)',
      adpick: adpickApiEnabled(this.config) ? 'api' : 'fallback(no key)',
    };
  }

  /** MySQL 에 실제로 붙는지, 테이블이 다 있는지 확인한다. */
  @Get('health/db')
  @ApiOperation({
    summary: 'MySQL 실제 연결 진단',
    description:
      '환경변수가 채워졌는지가 아니라 테이블마다 진짜 쿼리를 날려본다.\n' +
      '실패하면 원인별로 안내한다 (접속 불가 / 계정 거부 / 스키마 미적용).',
  })
  @ApiResponse({ status: 200, description: '전 테이블 정상' })
  @ApiResponse({ status: 503, description: '미설정 · 키 거부 · 테이블 없음' })
  async healthDb(@Res() res: Response): Promise<void> {
    if (!dbEnabled(this.config)) {
      res.status(503).json({
        status: 'disabled',
        reason: 'MYSQL_HOST / MYSQL_USER 가 비어 있습니다.',
        hint: '.env 를 확인하고 서버를 재시작하세요.',
      });
      return;
    }

    if (!this.mysql.getPool()) {
      res.status(503).json({
        status: 'error',
        reason: 'MySQL 커넥션 풀 생성 실패',
        hint: 'MYSQL_* 값을 확인하세요. 서버 로그에 원인이 남습니다.',
      });
      return;
    }

    const started = Date.now();
    const entries = await Promise.all(EXPECTED_TABLES.map((name) => this.probe(name)));
    const latencyMs = Date.now() - started;

    const tables = Object.fromEntries(entries) as Record<string, ProbeResult>;
    const failed = Object.entries(tables).filter(([, v]) => v !== true);

    if (failed.length) {
      res.status(503).json({ status: 'error', latencyMs, tables, hint: hintFor(tables) });
      return;
    }
    res.json({ status: 'ok', latencyMs, tables });
  }

  /**
   * 테이블 하나에 최소 쿼리를 날려본다. 성공하면 true, 실패하면 사유 문자열.
   *
   * 한 번은 재시도한다. 배포 직후 첫 접속이 순간 끊기는 일이 있는데, 그걸로
   * "DB 고장" 이라고 보고하면 진짜 문제를 찾는 데 방해가 된다.
   */
  private async probe(table: string, attempts = 2): Promise<[string, ProbeResult]> {
    const pool = this.mysql.getPool();
    if (!pool) return [table, 'no pool'];

    let last = 'unknown error';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await pool.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);
        return [table, true];
      } catch (err) {
        const code = (err as { code?: string }).code;
        last = short(`${code ?? ''} ${(err as Error).message ?? String(err)}`.trim());
      }
      this.logger.warn(
        `health/db probe failed table=${table} attempt=${attempt + 1} err=${last}`,
      );
      if (attempt + 1 < attempts) await sleep(200);
    }
    return [table, last];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function short(text: string): string {
  return text.split(/\s+/).join(' ').slice(0, 200);
}

/**
 * 실패 **내용**으로 먼저 분류하고, 그 다음 범위를 본다.
 * (범위부터 보면 401 을 '테이블 없음' 이라고 잘못 안내하게 된다.)
 */
export function hintFor(tables: Record<string, ProbeResult>): string {
  const failed = Object.entries(tables).filter(([, v]) => v !== true);
  if (!failed.length) return '';

  const blob = failed.map(([, v]) => String(v)).join(' ').toLowerCase();
  const everything = failed.length === Object.keys(tables).length;

  if (blob.includes('er_no_such_table') || blob.includes("doesn't exist")) {
    return `테이블이 없습니다. ${SCHEMA_FILE} 을 실행하세요 (배포 스크립트가 db/mysql/*.sql 을 자동으로 적용합니다 — 배포 로그를 확인하세요).`;
  }

  if (blob.includes('er_access_denied') || blob.includes('access denied')) {
    return everything
      ? '계정이 거부되었습니다. MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE 와 그 계정의 권한을 확인하세요.'
      : '일부 테이블만 권한이 없습니다. 계정 권한(GRANT)을 확인하세요.';
  }

  if (/econnrefused|etimedout|enotfound|ehostunreach|connect/.test(blob)) {
    return 'DB 에 접속하지 못했습니다. MYSQL_HOST(사설 IP)·MYSQL_PORT, 그리고 DB 서브넷 Security List 가 앱 서버에서 오는 3306 을 여는지 확인하세요.';
  }

  return everything
    ? '전 테이블 실패. MYSQL_* 값과 네트워크를 확인하세요.'
    : `${failed.map(([k]) => k).join(', ')} 만 실패했습니다. 다시 호출해도 같으면 스키마를 확인하세요.`;
}

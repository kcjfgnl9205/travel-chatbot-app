import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import { Response } from 'express';

import { AppConfig, CONFIG, adpickApiEnabled, dbEnabled } from '../../config/app.config';
import { EXPECTED_TABLES } from '../../config/database.config';
import { SupabaseService } from '../database/supabase.service';

/**
 * 헬스체크. 두 개로 나눈 이유:
 *
 *   /health     앱이 살아있나 (liveness). Caddy·compose 가 30초마다 두드린다.
 *               DB 를 건드리지 않는다 — DB 가 잠깐 흔들렸다고 컨테이너가 재시작되면 안 된다.
 *
 *   /health/db  Supabase 자격증명이 **실제로 먹는가** (진단용).
 *               환경변수가 채워졌는지가 아니라 진짜 쿼리를 날려본다.
 */

type ProbeResult = true | string;

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly supabase: SupabaseService,
  ) {}

  /** 앱 생존 확인. DB 는 건드리지 않는다. */
  @Get('health')
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      env: this.config.appEnv,
      db: dbEnabled(this.config) ? 'supabase' : 'disabled(no-op)',
      provider: this.config.hotelProvider,
      adpick: adpickApiEnabled(this.config) ? 'api' : 'fallback(no key)',
    };
  }

  /** Supabase 에 실제로 붙는지, 테이블이 다 있는지 확인한다. */
  @Get('health/db')
  async healthDb(@Res() res: Response): Promise<void> {
    if (!dbEnabled(this.config)) {
      res.status(503).json({
        status: 'disabled',
        reason: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 비어 있습니다.',
        hint: '.env 를 확인하고 서버를 재시작하세요.',
      });
      return;
    }

    const client = this.supabase.getClient();
    if (!client) {
      res.status(503).json({
        status: 'error',
        reason: 'Supabase 클라이언트 생성 실패',
        hint: 'SUPABASE_URL 형태가 https://{ref}.supabase.co 인지 확인하세요.',
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
   * 한 번은 재시도한다. 6개를 동시에 찌르면 Supabase 게이트웨이가 그중 하나를
   * 순간 거절하는 일이 있는데(빈 본문 401), 그걸로 "DB 고장" 이라고 보고하면
   * 진짜 문제를 찾는 데 방해가 된다.
   */
  private async probe(table: string, attempts = 2): Promise<[string, ProbeResult]> {
    const client = this.supabase.getClient();
    if (!client) return [table, 'no client'];

    let last = 'unknown error';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { error } = await client
        .from(table)
        .select('*', { head: true, count: 'exact' })
        .limit(1);
      if (!error) return [table, true];

      last = short(error.message || String(error));
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

  if (blob.includes('not exist') || blob.includes('schema cache') || blob.includes('pgrst205')) {
    return '테이블이 없습니다. SQL Editor 에서 0001_init.sql 을 실행하세요.';
  }

  if (
    blob.includes('401') ||
    blob.includes('invalid') ||
    blob.includes('jwt') ||
    blob.includes('api key')
  ) {
    return everything
      ? '키가 거부되었습니다. anon/publishable 이 아니라 Settings → API Keys 의 secret(sb_secret_...) 또는 Legacy 탭의 service_role 인지 확인하세요.'
      : '일부만 401 입니다. 키가 틀렸다면 전부 실패해야 하므로, 동시 요청에 대한 일시적 거절일 가능성이 큽니다. 다시 호출해보세요.';
  }

  return everything
    ? '전 테이블 실패. SUPABASE_URL·키·네트워크를 확인하세요.'
    : `${failed.map(([k]) => k).join(', ')} 만 실패했습니다. 다시 호출해도 같으면 스키마를 확인하세요.`;
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

import { AppConfig, CONFIG, dbEnabled } from '../config/configuration';

/**
 * Supabase 접근 래퍼.
 *
 * 설계 원칙 2가지
 * 1. **자격증명이 없으면 null 을 돌려주고 앱은 그대로 동작한다.** (no-op 모드)
 *    로컬에서 카카오 응답 JSON만 확인할 때 Supabase 없이 띄울 수 있어야 하므로.
 * 2. **DB 오류가 챗봇 응답을 죽이면 안 된다.** 로깅은 부가 기능이지 본 기능이 아니다.
 *    그래서 repository 들은 실패 시 예외 대신 null 을 돌려준다.
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private client: SupabaseClient | null = null;
  private initFailed = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  getClient(): SupabaseClient | null {
    if (!dbEnabled(this.config) || this.initFailed) return null;
    if (this.client) return this.client;

    try {
      this.client = createClient(
        this.config.supabaseUrl,
        this.config.supabaseServiceRoleKey,
        // 서버 전용이라 세션을 들고 있을 필요가 없다.
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      this.logger.log('supabase client ready');
    } catch (err) {
      this.initFailed = true;
      this.logger.error(`supabase client init failed; running without DB: ${err}`);
      return null;
    }
    return this.client;
  }

  get enabled(): boolean {
    return this.getClient() !== null;
  }

  /** 테스트용. */
  reset(): void {
    this.client = null;
    this.initFailed = false;
  }
}

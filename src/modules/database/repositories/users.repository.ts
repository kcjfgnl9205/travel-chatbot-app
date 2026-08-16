import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

@Injectable()
export class UsersRepository extends BaseRepository {
  protected readonly tableName = 'users';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /** 카카오 botUserKey 로 사용자 upsert 후 행을 돌려준다. */
  async getOrCreate(kakaoUserKey: string): Promise<Record<string, any> | null> {
    const existing = await this.runOne(
      (t) => t.select('*').eq('kakao_user_key', kakaoUserKey).limit(1),
      'select user',
    );
    if (existing) return existing;

    return this.runOne(
      (t) =>
        t
          .upsert({ kakao_user_key: kakaoUserKey }, { onConflict: 'kakao_user_key' })
          .select('*'),
      'upsert user',
    );
  }
}

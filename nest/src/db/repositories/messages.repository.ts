import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

export interface LogMessageInput {
  userId: string | null;
  domain: string;
  utterance: string;
  blockName?: string | null;
  parsedCity?: string | null;
  params?: Record<string, unknown>;
  rawPayload?: unknown;
}

@Injectable()
export class MessagesRepository extends BaseRepository {
  protected readonly tableName = 'messages';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async log(input: LogMessageInput): Promise<Record<string, any> | null> {
    const record = {
      user_id: input.userId,
      domain: input.domain,
      utterance: input.utterance,
      block_name: input.blockName ?? null,
      parsed_city: input.parsedCity ?? null,
      params: input.params ?? {},
      raw_payload: input.rawPayload ?? null,
    };
    return this.runOne((t) => t.insert(record).select('id'), 'insert message');
  }
}

import { Injectable } from '@nestjs/common';

import { MysqlService } from '../mysql.service';
import { BaseRepository } from './base.repository';

export interface LogMessageInput {
  /**
   * 행 id 를 **호출부가 정한다.** 비우면 여기서 만든다.
   *
   * 노출 기록(recommendations)이 이 id 를 FK 로 물고 있어서, 예전에는 insert 를
   * 기다려 id 를 받아야 다음 단계로 갈 수 있었다. 그 왕복이 카카오 3.5초 예산
   * 안에 있었다 — id 를 미리 정하면 쓰기를 전부 응답 뒤로 밀 수 있다.
   */
  id?: string;
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

  constructor(db: MysqlService) {
    super(db);
  }

  async log(input: LogMessageInput): Promise<{ id: string } | null> {
    const id = input.id ?? crypto.randomUUID();
    const { sql, params } = this.insertSql([
      {
        id,
        user_id: input.userId,
        domain: input.domain,
        utterance: input.utterance,
        block_name: input.blockName ?? null,
        parsed_city: input.parsedCity ?? null,
        params: input.params ?? {},
        raw_payload: input.rawPayload ?? null,
      },
    ]);
    return (await this.execute(sql, params, 'insert message')) ? { id } : null;
  }
}

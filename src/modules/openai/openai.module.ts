import { Module } from '@nestjs/common';

import { OpenAiService } from './openai.service';

/** OpenAI Responses API 클라이언트. 도메인 지식은 없다 — 호출 껍데기만 담당한다. */
@Module({
  providers: [OpenAiService],
  exports: [OpenAiService],
})
export class OpenAiModule {}

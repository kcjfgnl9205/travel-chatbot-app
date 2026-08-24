import { Module } from '@nestjs/common';

import { OpenAiModule } from '../openai/openai.module';
import { NluService } from './nlu.service';

/** 발화 파싱. 카카오 5초 예산 안에서 도는 유일한 모델 호출이 여기 있다. */
@Module({
  imports: [OpenAiModule],
  providers: [NluService],
  exports: [NluService],
})
export class NluModule {}

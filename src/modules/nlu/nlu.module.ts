import { Module } from '@nestjs/common';

import { OpenAiModule } from '../openai/openai.module';
import { FlightNluService } from './flight-nlu.service';
import { NluService } from './nlu.service';

/**
 * 발화 파싱. 카카오 5초 예산 안에서 도는 유일한 모델 호출이 여기 있다.
 *
 * 도메인마다 뽑을 게 다르므로 파서도 따로 둔다 (호텔: 도시+인원, 항공권: 노선+날짜).
 */
@Module({
  imports: [OpenAiModule],
  providers: [NluService, FlightNluService],
  exports: [NluService, FlightNluService],
})
export class NluModule {}

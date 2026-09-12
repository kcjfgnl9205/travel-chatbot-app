import { Module } from '@nestjs/common';

import { OpenAiModule } from '../openai/openai.module';
import { IntentService } from './intent.service';

/**
 * 발화 해석. 카카오 5초 예산 안에서 도는 모델 호출이 여기 하나뿐이다
 * (지역 정규화가 사전을 벗어나면 PlacesService 에서 한 번 더 나갈 수 있다).
 */
@Module({
  imports: [OpenAiModule],
  providers: [IntentService],
  exports: [IntentService],
})
export class IntentModule {}

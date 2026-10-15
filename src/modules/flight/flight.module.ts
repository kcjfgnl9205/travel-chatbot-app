import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { FlightService } from './flight.service';

/**
 * 항공권 도메인.
 *
 * ⚠️ **provider 가 없다.** 모델에게 시세를 묻던 자리인데, 줄 링크를 어차피 우리가
 *    조립하므로 시세 한 줄을 포기하고 걷어냈다 ([link-offers.ts](./link-offers.ts)).
 *    그래서 OpenAiModule 도 안 쓴다 — 항공권은 OPENAI_API_KEY 없이도 동작한다.
 *
 *    실시간 운임 API(GDS·항공사)를 붙일 때는 provider 를 다시 세우기보다,
 *    시세를 **미리 채워두는 표**를 만들어 링크 카드 위에 숫자만 얹는 쪽이
 *    요청 경로를 느리게 하지 않는다.
 */
@Module({
  imports: [AffiliateModule, RecommendationModule],
  providers: [FlightService],
  exports: [FlightService],
})
export class FlightModule {}

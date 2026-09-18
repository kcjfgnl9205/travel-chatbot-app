import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { OpenAiModule } from '../openai/openai.module';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { FlightService } from './flight.service';
import { FLIGHT_PROVIDER } from './flight.types';
import { OpenAiFlightProvider } from './providers/openai.provider';

/**
 * 항공권 도메인. 실시간 운임 API(GDS·항공사)가 붙으면 provider 만 바꾸면 된다.
 */
@Module({
  imports: [AffiliateModule, OpenAiModule, RecommendationModule],
  providers: [
    OpenAiFlightProvider,
    { provide: FLIGHT_PROVIDER, useExisting: OpenAiFlightProvider },
    FlightService,
  ],
  exports: [FlightService],
})
export class FlightModule {}

import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { NluModule } from '../nlu/nlu.module';
import { OpenAiModule } from '../openai/openai.module';
import { SearchCacheModule } from '../search-cache/search-cache.module';
import { FlightDebugController } from './flight-debug.controller';
import { FlightService } from './flight.service';
import { FLIGHT_PROVIDER } from './flight.types';
import { OpenAiFlightProvider } from './providers/openai.provider';

/**
 * 항공권 검색 유스케이스.
 * provider 를 갈아끼우면 데이터 소스가 바뀐다. 지금은 openai 하나뿐이다 —
 * 실시간 운임 API(GDS·항공사)가 붙으면 여기만 바꾸면 된다.
 */
@Module({
  imports: [AffiliateModule, SearchCacheModule, OpenAiModule, NluModule],
  // 진단 컨트롤러는 provider 구현체를 직접 쓴다 (단계별 계측이 필요해서).
  controllers: [FlightDebugController],
  providers: [
    OpenAiFlightProvider,
    { provide: FLIGHT_PROVIDER, useExisting: OpenAiFlightProvider },
    FlightService,
  ],
  exports: [FlightService],
})
export class FlightModule {}

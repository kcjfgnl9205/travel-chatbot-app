import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { NluModule } from '../nlu/nlu.module';
import { OpenAiModule } from '../openai/openai.module';
import { SearchCacheModule } from '../search-cache/search-cache.module';
import { HotelDebugController } from './hotel-debug.controller';
import { HotelService } from './hotel.service';
import { HOTEL_PROVIDER } from './hotel.types';
import { OpenAiHotelProvider } from './providers/openai.provider';

/**
 * 호텔 추천 유스케이스.
 * provider 를 갈아끼우면 데이터 소스가 바뀐다. 지금은 openai 하나뿐이다.
 */
@Module({
  imports: [AffiliateModule, SearchCacheModule, OpenAiModule, NluModule],
  // 진단 컨트롤러는 provider 구현체를 직접 쓴다 (단계별 계측이 필요해서).
  controllers: [HotelDebugController],
  providers: [
    OpenAiHotelProvider,
    { provide: HOTEL_PROVIDER, useExisting: OpenAiHotelProvider },
    HotelService,
  ],
  exports: [HotelService],
})
export class HotelModule {}

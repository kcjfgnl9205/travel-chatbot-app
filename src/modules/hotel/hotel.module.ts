import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { SearchCacheModule } from '../search-cache/search-cache.module';
import { HotelService } from './hotel.service';
import { StaticHotelProvider } from './providers/static.provider';

/**
 * 호텔 추천 유스케이스.
 * provider 를 갈아끼우면 데이터 소스가 바뀐다 (static → ai/crawler).
 */
@Module({
  imports: [AffiliateModule, SearchCacheModule],
  providers: [StaticHotelProvider, HotelService],
  exports: [HotelService],
})
export class HotelModule {}

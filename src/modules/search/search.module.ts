import { Module } from '@nestjs/common';

import { AttractionModule } from '../attraction/attraction.module';
import { FlightModule } from '../flight/flight.module';
import { HotelModule } from '../hotel/hotel.module';
import { PlacesModule } from '../places/places.module';
import { SearchStoreService } from './search-store.service';
import { SearchService } from './search.service';

/**
 * 검색 오케스트레이션.
 *
 * 도메인 모듈을 여기서 모은다 — 세 도메인은 서로를 모르고, 라우터는 도메인을 모른다.
 * 의존은 한 방향(라우터 → 검색 → 도메인)이라 순환이 생기지 않는다.
 */
@Module({
  imports: [HotelModule, FlightModule, AttractionModule, PlacesModule],
  providers: [SearchService, SearchStoreService],
  // 도메인 모듈을 다시 내보낸다 — 진단 컨트롤러가 같은 인스턴스를 써야
  // 진단과 운영이 다른 provider 를 보지 않는다.
  exports: [SearchService, SearchStoreService, HotelModule, FlightModule, AttractionModule],
})
export class SearchModule {}

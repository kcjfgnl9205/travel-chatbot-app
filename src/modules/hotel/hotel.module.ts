import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { OpenAiModule } from '../openai/openai.module';
import { HotelService } from './hotel.service';
import { HOTEL_PROVIDER } from './hotel.types';
import { OpenAiHotelProvider } from './providers/openai.provider';

/**
 * 호텔 도메인. provider 를 갈아끼우면 데이터 소스가 바뀐다 — 지금은 openai 하나뿐이다.
 *
 * 컨트롤러가 없다. 진입점은 라우터 하나뿐이고, 이 모듈은 SearchService 가 부르는
 * **검색 + 카드 한 줄 그리기**만 책임진다.
 */
@Module({
  imports: [AffiliateModule, OpenAiModule],
  providers: [
    OpenAiHotelProvider,
    { provide: HOTEL_PROVIDER, useExisting: OpenAiHotelProvider },
    HotelService,
  ],
  exports: [HotelService],
})
export class HotelModule {}

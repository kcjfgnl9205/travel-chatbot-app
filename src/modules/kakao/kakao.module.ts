import { Module } from '@nestjs/common';

import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import { FlightModule } from '../flight/flight.module';
import { HotelModule } from '../hotel/hotel.module';
import { NluModule } from '../nlu/nlu.module';
import { KakaoController } from './kakao.controller';

/** 오픈빌더 스킬 엔드포인트 (호텔 추천 / 항공권 검색 / 폴백). */
@Module({
  imports: [HotelModule, FlightModule, NluModule],
  controllers: [KakaoController],
  providers: [SkillTokenGuard],
})
export class KakaoModule {}

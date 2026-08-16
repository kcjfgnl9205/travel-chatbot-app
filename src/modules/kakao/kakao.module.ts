import { Module } from '@nestjs/common';

import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import { HotelModule } from '../hotel/hotel.module';
import { KakaoController } from './kakao.controller';

/** 오픈빌더 스킬 엔드포인트 (추천 / 폴백). */
@Module({
  imports: [HotelModule],
  controllers: [KakaoController],
  providers: [SkillTokenGuard],
})
export class KakaoModule {}

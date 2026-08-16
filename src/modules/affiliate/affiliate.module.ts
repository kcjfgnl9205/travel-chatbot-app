import { Module } from '@nestjs/common';

import { AdpickModule } from '../adpick/adpick.module';
import { AffiliateService } from './affiliate.service';

/** 캐시 우선 제휴 링크 해석 (affiliate_links → 없으면 애드픽 호출). */
@Module({
  imports: [AdpickModule],
  providers: [AffiliateService],
  exports: [AffiliateService],
})
export class AffiliateModule {}

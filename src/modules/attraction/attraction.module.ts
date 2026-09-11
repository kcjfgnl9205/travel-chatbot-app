import { Module } from '@nestjs/common';

import { NluModule } from '../nlu/nlu.module';
import { OpenAiModule } from '../openai/openai.module';
import { SearchCacheModule } from '../search-cache/search-cache.module';
import { AttractionDebugController } from './attraction-debug.controller';
import { AttractionService } from './attraction.service';
import { ATTRACTION_PROVIDER } from './attraction.types';
import { OpenAiAttractionProvider } from './providers/openai.provider';

/**
 * 관광지 추천 유스케이스.
 *
 * **AffiliateModule 을 import 하지 않는다.** 관광지는 예약할 게 없어서 애드픽에
 * 변환할 주소가 없다 — 링크는 이름+도시로 만든 구글맵 주소다. 호텔·항공권 모듈과
 * 비교하면 이 한 줄이 없는 게 가장 큰 차이다.
 */
@Module({
  imports: [SearchCacheModule, OpenAiModule, NluModule],
  // 진단 컨트롤러는 provider 구현체를 직접 쓴다 (단계별 계측이 필요해서).
  controllers: [AttractionDebugController],
  providers: [
    OpenAiAttractionProvider,
    { provide: ATTRACTION_PROVIDER, useExisting: OpenAiAttractionProvider },
    AttractionService,
  ],
  exports: [AttractionService],
})
export class AttractionModule {}

import { Module } from '@nestjs/common';

import { OpenAiModule } from '../openai/openai.module';
import { PlacesModule } from '../places/places.module';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { AttractionAdminController } from './attraction-admin.controller';
import { AttractionBackfillService } from './attraction-backfill';
import { AttractionService } from './attraction.service';
import { ATTRACTION_PROVIDER } from './attraction.types';
import { DbAttractionProvider } from './providers/db.provider';

/**
 * 관광지 도메인.
 *
 * **AffiliateModule 을 import 하지 않는다.** 관광지는 예약할 게 없어서 애드픽에
 * 변환할 주소가 없다 — 링크는 이름+도시로 만든 구글맵 주소다. 호텔·항공권 모듈과
 * 비교하면 이 한 줄이 없는 게 가장 큰 차이다.
 *
 * OpenAiModule 은 **빈 도시를 채울 때만** 쓴다
 * ([attraction-backfill.ts](./attraction-backfill.ts)). 목록이 있는 도시는 모델을
 * 부르지 않는다 — 호텔·항공권이 매 검색마다 부르는 것과 다른 지점이다.
 *
 * PlacesModule 은 관리 API 가 "오사카" 를 `places` 행으로 바꾸는 데 쓴다. 그 해석이
 * 검색 경로와 같아야 등록한 것이 카드에 보인다.
 *
 * `AttractionsRepository` 는 DatabaseModule 이 @Global 로 내보낸다.
 */
@Module({
  imports: [RecommendationModule, PlacesModule, OpenAiModule],
  controllers: [AttractionAdminController],
  providers: [
    DbAttractionProvider,
    { provide: ATTRACTION_PROVIDER, useExisting: DbAttractionProvider },
    AttractionBackfillService,
    AttractionService,
  ],
  exports: [AttractionService],
})
export class AttractionModule {}

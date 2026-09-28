import { Module } from '@nestjs/common';

import { PlacesModule } from '../places/places.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * 씨앗 도시 등록.
 *
 * **0009 에서 SearchModule 의존이 빠졌다.** 예전에는 배치가 SearchService.warm 을
 * 불러 캐시를 데웠는데, 관광지 목록이 우리 DB 로 오면서 데울 것이 없어졌다.
 * 이제 이 모듈이 아는 것은 `places` 뿐이다.
 */
@Module({
  imports: [PlacesModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}

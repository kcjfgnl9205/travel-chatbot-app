import { Module } from '@nestjs/common';

import { PlacesModule } from '../places/places.module';
import { SearchModule } from '../search/search.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * 관광지 목록을 미리 채우는 배치.
 *
 * **검색 모듈에 얹지 않고 따로 둔다.** 이쪽이 SearchService 를 쓰는데, 검색 모듈은
 * 도메인 모듈들을 쓴다 — 배치를 그 안에 넣으면 의존이 한 방향이 아니게 된다
 * (검색 → 관광지 → 검색). 배치는 맨 바깥에 있는 게 맞다.
 */
@Module({
  imports: [SearchModule, PlacesModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}

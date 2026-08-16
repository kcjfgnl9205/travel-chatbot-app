import { Module } from '@nestjs/common';

import { SearchCacheService } from './search-cache.service';

/** 검색 결과 캐시. AI/크롤링 provider 가 붙으면 비용·지연을 좌우한다. */
@Module({ providers: [SearchCacheService], exports: [SearchCacheService] })
export class SearchCacheModule {}

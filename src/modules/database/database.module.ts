import { Global, Module } from '@nestjs/common';

import { MemoryStoreService } from './memory-store.service';
import { AffiliateLinksRepository } from './repositories/affiliate-links.repository';
import { MessagesRepository } from './repositories/messages.repository';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from './repositories/recommendations.repository';
import { SearchCacheRepository } from './repositories/search-cache.repository';
import { UsersRepository } from './repositories/users.repository';
import { SupabaseService } from './supabase.service';

const PROVIDERS = [
  SupabaseService,
  MemoryStoreService,
  UsersRepository,
  MessagesRepository,
  RecommendationsRepository,
  RecommendationItemsRepository,
  AffiliateLinksRepository,
  SearchCacheRepository,
];

/**
 * DB 접근 계층. 여러 도메인이 같은 레포지토리를 쓰므로 전역으로 둔다.
 * 모든 레포지토리는 실패해도 예외를 올리지 않고 null 을 돌려준다.
 */
@Global()
@Module({ providers: PROVIDERS, exports: PROVIDERS })
export class DatabaseModule {}

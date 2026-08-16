import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdpickService } from './adpick/adpick.service';
import { AffiliateService } from './affiliate/affiliate.service';
import { HealthController } from './api/health.controller';
import { KakaoHotelController } from './api/kakao-hotel.controller';
import { RedirectController } from './api/redirect.controller';
import { SkillTokenGuard } from './api/skill-token.guard';
import { CONFIG, loadConfig } from './config/configuration';
import { MemoryStoreService } from './db/memory-store.service';
import { AffiliateLinksRepository } from './db/repositories/affiliate-links.repository';
import { MessagesRepository } from './db/repositories/messages.repository';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from './db/repositories/recommendations.repository';
import { SearchCacheRepository } from './db/repositories/search-cache.repository';
import { UsersRepository } from './db/repositories/users.repository';
import { SupabaseService } from './db/supabase.service';
import { HotelService } from './hotel/hotel.service';
import { StaticHotelProvider } from './hotel/providers/static.provider';
import { SearchCacheService } from './search-cache/search-cache.service';

@Module({
  imports: [
    // 파이썬판과 같은 .env 를 읽는다. repo 루트(../.env)를 먼저 본다.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
  ],
  controllers: [KakaoHotelController, RedirectController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    SkillTokenGuard,
    SupabaseService,
    MemoryStoreService,
    UsersRepository,
    MessagesRepository,
    RecommendationsRepository,
    RecommendationItemsRepository,
    AffiliateLinksRepository,
    SearchCacheRepository,
    AdpickService,
    AffiliateService,
    SearchCacheService,
    StaticHotelProvider,
    HotelService,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';

import { IntentModule } from '../intent/intent.module';
import { PlacesModule } from '../places/places.module';
import { SearchModule } from '../search/search.module';
import { DebugController } from './debug.controller';

/**
 * 진단 엔드포인트. **DEBUG_TOKEN 이 비어 있으면 전부 404 다.**
 *
 * 도메인 서비스는 SearchModule 이 이미 모아 내보낸다 — 여기서 다시 등록하면
 * provider 인스턴스가 둘이 되고, 그러면 진단과 운영이 다른 캐시를 보게 된다.
 */
@Module({
  imports: [IntentModule, PlacesModule, SearchModule],
  controllers: [DebugController],
})
export class DebugModule {}

import { Module } from '@nestjs/common';

import { IntentModule } from '../intent/intent.module';
import { SearchModule } from '../search/search.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

/**
 * 서비스 데이터 초기화.
 *
 * DatabaseModule 은 @Global 이라 레포지토리는 그냥 주입된다. SearchModule·IntentModule 을
 * 가져오는 건 **같은 인스턴스의 메모리 캐시를 비워야 하기 때문이다** — 비우기가
 * 다른 provider 를 보면 DB 만 비고 캐시는 살아남는다.
 */
@Module({
  imports: [SearchModule, IntentModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}

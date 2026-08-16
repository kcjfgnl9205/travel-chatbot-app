import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './modules/database/database.module';
import { HealthModule } from './modules/health/health.module';
import { KakaoModule } from './modules/kakao/kakao.module';
import { RedirectModule } from './modules/redirect/redirect.module';

/**
 * 최상위 루트 모듈.
 *
 * AppConfigModule 과 DatabaseModule 은 @Global 이라 하위 모듈이 따로 import 하지 않는다.
 * 나머지는 진입점(controller)을 가진 모듈만 여기에 올린다.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, KakaoModule, RedirectModule, HealthModule],
})
export class AppModule {}

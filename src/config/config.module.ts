import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { CONFIG, loadConfig } from './app.config';

/**
 * 환경변수를 한 번 읽어 AppConfig 로 얼려서 전역 제공한다.
 * 어느 모듈에서든 @Inject(CONFIG) 로 받는다.
 */
@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] })],
  providers: [{ provide: CONFIG, useFactory: loadConfig }],
  exports: [CONFIG],
})
export class AppConfigModule {}

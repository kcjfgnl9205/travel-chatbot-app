import { Module } from '@nestjs/common';

import { SearchModule } from '../search/search.module';
import { HealthController } from './health.controller';

/**
 * /health(liveness) 와 /health/db(실제 연결 진단).
 *
 * SearchModule 을 import 하는 이유는 **어떤 provider 가 실제로 붙어 있는지**를
 * 설정이 아니라 주입된 인스턴스에서 읽기 위해서다.
 */
@Module({ imports: [SearchModule], controllers: [HealthController] })
export class HealthModule {}

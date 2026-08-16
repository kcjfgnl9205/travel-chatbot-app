import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** /health(liveness) 와 /health/db(실제 연결 진단). */
@Module({ controllers: [HealthController] })
export class HealthModule {}

import { Logger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

const LEVELS: Record<string, LogLevel[]> = {
  DEBUG: ['error', 'warn', 'log', 'debug', 'verbose'],
  INFO: ['error', 'warn', 'log'],
  WARNING: ['error', 'warn'],
  ERROR: ['error'],
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: LEVELS[(process.env.LOG_LEVEL ?? 'INFO').toUpperCase()] ?? LEVELS.INFO,
  });

  // 컨테이너 밖에서 접근하려면 0.0.0.0 이어야 한다.
  const port = Number(process.env.PORT ?? 8000);
  await app.listen(port, '0.0.0.0');
  new Logger('bootstrap').log(`listening on http://0.0.0.0:${port}`);
}

void bootstrap();

import { INestApplication, Logger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

const LEVELS: Record<string, LogLevel[]> = {
  DEBUG: ['error', 'warn', 'log', 'debug', 'verbose'],
  INFO: ['error', 'warn', 'log'],
  WARNING: ['error', 'warn'],
  ERROR: ['error'],
};

/**
 * Swagger.
 *
 * 로컬이든 운영이든 항상 켠다. 끄고 켜는 스위치를 두지 않는다 —
 * 운영 서버의 .env 는 저장소에 없어서, 환경변수로 잠가두면
 * 배포만으로는 /docs 를 되살릴 방법이 없다.
 */
function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('travel-chatbot-app')
    .setDescription(
      '카카오톡 여행 챗봇 스킬 서버 (호텔 MVP).\n\n' +
        '`X-Skill-Token` 은 KAKAO_SKILL_TOKEN 을 설정한 경우에만 검증한다 — ' +
        '로컬에서는 비워두면 그냥 통과한다.',
    )
    .setVersion('0.1.0')
    .addApiKey(
      { type: 'apiKey', name: 'X-Skill-Token', in: 'header' },
      'X-Skill-Token',
    )
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    swaggerOptions: { persistAuthorization: true },
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: LEVELS[(process.env.LOG_LEVEL ?? 'INFO').toUpperCase()] ?? LEVELS.INFO,
  });

  setupSwagger(app);

  // 컨테이너 밖에서 접근하려면 0.0.0.0 이어야 한다.
  const port = Number(process.env.PORT ?? 8000);
  await app.listen(port, '0.0.0.0');

  const logger = new Logger('bootstrap');
  logger.log(`listening on http://0.0.0.0:${port}`);
  logger.log(`swagger  on http://0.0.0.0:${port}/docs`);
}

void bootstrap();

import { Logger, LogLevel } from '@nestjs/common';
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
 * 운영에서는 기본으로 끈다 — 스킬 URL·토큰 헤더 이름이 그대로 노출되고,
 * 공개 IP 는 이미 스캐너가 훑고 있다. 필요하면 SWAGGER_ENABLED=true 로 켠다.
 */
function setupSwagger(app: Parameters<typeof SwaggerModule.createDocument>[0]): void {
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

  SwaggerModule.setup('docs', app as never, SwaggerModule.createDocument(app, config), {
    swaggerOptions: { persistAuthorization: true },
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: LEVELS[(process.env.LOG_LEVEL ?? 'INFO').toUpperCase()] ?? LEVELS.INFO,
  });

  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.SWAGGER_ENABLED !== 'false' && process.env.APP_ENV !== 'production');
  if (swaggerEnabled) setupSwagger(app);

  // 컨테이너 밖에서 접근하려면 0.0.0.0 이어야 한다.
  const port = Number(process.env.PORT ?? 8000);
  await app.listen(port, '0.0.0.0');

  const logger = new Logger('bootstrap');
  logger.log(`listening on http://0.0.0.0:${port}`);
  logger.log(swaggerEnabled ? `swagger  on http://0.0.0.0:${port}/docs` : 'swagger disabled');
}

void bootstrap();

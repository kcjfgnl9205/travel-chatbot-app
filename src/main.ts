import { INestApplication, Logger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { AppConfig, CONFIG } from './config/app.config';
import { PAGE_SIZE } from './modules/kakao/paging';

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

  warnAboutPaging(app.get<AppConfig>(CONFIG), logger);
}

/**
 * **설정이 기능을 조용히 꺼버리는 자리를 짚어준다.**
 *
 * RESULT_MAX_ITEMS 가 한 페이지(5) 이하면 넘길 게 없어서 "더 보기" 버튼이 아예 안
 * 달린다. 오류가 아니라 정상 동작이라 로그도 예외도 안 남는데, 보는 사람에게는 버튼이
 * 사라진 것처럼 보인다. 실제로 .env 에 예전 값(HOTEL_RESULT_LIMIT=5)이 남아 있어서
 * 호텔만 버튼이 안 나온 적이 있다.
 *
 * ⚠️ 배포해도 서버의 .env 는 그대로 남는다(deploy/remote.sh). 코드 기본값을 올려도
 *    서버에 옛 값이 있으면 그게 이긴다 — 그래서 **실효값**을 찍는다.
 */
function warnAboutPaging(config: AppConfig, logger: Logger): void {
  logger.log(
    `result max=${config.resultMaxItems} page=${PAGE_SIZE} ` +
      `(candidates=${config.openaiCandidateCount}) ` +
      `ttl(min) hotel=${config.hotelCacheTtlMinutes} flight=${config.flightCacheTtlMinutes} ` +
      `attraction=${config.attractionCacheTtlMinutes}`,
  );

  if (config.resultMaxItems <= PAGE_SIZE) {
    logger.warn(
      `RESULT_MAX_ITEMS=${config.resultMaxItems} 이라 한 페이지(${PAGE_SIZE})를 못 넘는다 — ` +
        `"더 보기" 버튼이 안 달린다. 페이지를 넘기려면 ${PAGE_SIZE + 1} 이상으로 올려라.`,
    );
  }

  if (config.openaiCandidateCount <= config.resultMaxItems) {
    logger.warn(
      `OPENAI_CANDIDATE_COUNT=${config.openaiCandidateCount} 가 RESULT_MAX_ITEMS 보다 크지 않다 — ` +
        `2차 호출이 후보를 전부 써야 해서 선별(카테고리 섞기·순위)이 사실상 안 돈다.`,
    );
  }
}

void bootstrap();

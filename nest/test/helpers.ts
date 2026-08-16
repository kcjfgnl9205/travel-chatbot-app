import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

export function kakaoPayload(
  utterance: string,
  userKey = 'test-user',
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: { id: 'intent-1', name: '블록 이름' },
    userRequest: {
      timezone: 'Asia/Seoul',
      params: {},
      block: { id: 'block-1', name: '호텔추천' },
      utterance,
      lang: 'kr',
      user: { id: userKey, type: 'accountId', properties: { botUserKey: userKey } },
    },
    bot: { id: 'bot-1', name: '여행봇' },
    action: { name: '호텔추천액션', clientExtra: {}, params, detailParams: {}, id: 'action-1' },
  };
}

export const listCardOf = (body: any) =>
  body.template.outputs.find((o: any) => o.listCard).listCard;

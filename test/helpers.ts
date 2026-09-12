import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { createServer, Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { ATTRACTION_PROVIDER } from '../src/modules/attraction/attraction.types';
import { FLIGHT_PROVIDER } from '../src/modules/flight/flight.types';
import { HOTEL_PROVIDER } from '../src/modules/hotel/hotel.types';
import { OpenAiService } from '../src/modules/openai/openai.service';
import { FakeAttractionProvider } from './fake-attraction-provider';
import { FakeFlightProvider } from './fake-flight-provider';
import { FakeHotelProvider } from './fake-provider';
import { FakeOpenAiService } from './fake-openai';

export const RECOMMEND = '/api/v1/kakao/hotels/recommend';
export const FLIGHTS = '/api/v1/kakao/flights/search';
export const ATTRACTIONS = '/api/v1/kakao/attractions/recommend';

export interface TestApp {
  app: INestApplication;
  provider: FakeHotelProvider;
  flightProvider: FakeFlightProvider;
  attractionProvider: FakeAttractionProvider;
  openai: FakeOpenAiService;
}

export async function createApp(): Promise<TestApp> {
  const provider = new FakeHotelProvider();
  const flightProvider = new FakeFlightProvider();
  const attractionProvider = new FakeAttractionProvider();
  const openai = new FakeOpenAiService();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // 실제 OpenAI 를 부르지 않는다 — 검색(provider)도, 발화 파싱(OpenAiService)도.
    .overrideProvider(HOTEL_PROVIDER)
    .useValue(provider)
    .overrideProvider(FLIGHT_PROVIDER)
    .useValue(flightProvider)
    .overrideProvider(ATTRACTION_PROVIDER)
    .useValue(attractionProvider)
    .overrideProvider(OpenAiService)
    .useValue(openai)
    .compile();

  const app = moduleRef.createNestApplication();
  // init() 이 아니라 listen() 인 이유: supertest 는 서버가 안 떠 있으면 요청마다
  // listen(0) 을 부른다. 동시 요청 테스트에서 그게 서로 경합해 ECONNRESET 이 난다.
  await app.listen(0);
  return { app, provider, flightProvider, attractionProvider, openai };
}

export function kakaoPayload(
  utterance: string,
  userKey = 'test-user',
  params: Record<string, unknown> = {},
  callbackUrl?: string,
): Record<string, unknown> {
  const userRequest: Record<string, unknown> = {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: 'block-1', name: '호텔추천' },
    utterance,
    lang: 'kr',
    user: { id: userKey, type: 'accountId', properties: { botUserKey: userKey } },
  };
  // 오픈빌더에서 콜백을 켠 블록만 이 필드를 실어 보낸다.
  if (callbackUrl) userRequest.callbackUrl = callbackUrl;

  return {
    intent: { id: 'intent-1', name: '블록 이름' },
    userRequest,
    bot: { id: 'bot-1', name: '여행봇' },
    action: { name: '호텔추천액션', clientExtra: {}, params, detailParams: {}, id: 'action-1' },
  };
}

export const listCardOf = (body: any) =>
  body.template?.outputs?.find((o: any) => o.listCard)?.listCard;

/**
 * 카드가 나올 때까지 다시 물어본다.
 *
 * 캐시 미스는 즉시 카드를 주지 않는다 — 백그라운드 검색이 끝나야 캐시에 들어간다.
 * 콜백을 안 쓰는 경로에서 "잠시 후 다시 물어보면 나온다"가 실제로 되는지도 같이 검증된다.
 */
export async function recommendUntilCard(
  app: INestApplication,
  utterance: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await request(app.getHttpServer())
      .post(RECOMMEND)
      .send(kakaoPayload(utterance, 'test-user', params));
    const card = listCardOf(res.body);
    if (card) return card;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`listCard 가 나오지 않았다: ${utterance}`);
}

/** 카카오 콜백 수신기 흉내. POST 로 들어온 첫 본문을 돌려준다. */
export async function callbackReceiver(): Promise<{
  url: string;
  received: Promise<any>;
  close: () => Promise<void>;
}> {
  let resolve!: (body: any) => void;
  const received = new Promise<any>((r) => {
    resolve = r;
  });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"SUCCESS"}');
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/callback`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ------------------------------------------------------------------ 항공권
export const carouselOf = (body: any) =>
  body.template?.outputs?.find((o: any) => o.carousel)?.carousel;

/** 캐러셀 안의 itemCard 목록. 없으면 undefined. (FLIGHT_CARD_STYLE=carousel 일 때) */
export const itemCardsOf = (body: any) => {
  const carousel = carouselOf(body);
  return carousel?.type === 'itemCard' ? carousel.items : undefined;
};

/**
 * 항공권 listCard 의 줄 목록. 없으면 undefined.
 *
 * 항공권은 안내 말풍선 뒤에 카드가 오므로 outputs[0] 이 아니다 — 찾아서 꺼낸다.
 */
export const flightRowsOf = (body: any) =>
  body.template?.outputs?.find((o: any) => o.listCard)?.listCard?.items;

/**
 * 카드가 나올 때까지 다시 물어본다 (항공권).
 *
 * 캐시 미스는 즉시 카드를 주지 않는다 — 백그라운드 검색이 끝나야 캐시에 들어간다.
 * 콜백을 안 쓰는 경로에서 "잠시 후 다시 물어보면 나온다"가 실제로 되는지도 같이 검증된다.
 */
export async function searchUntilCards(
  app: INestApplication,
  utterance: string,
  params: Record<string, unknown> = {},
): Promise<any[]> {
  return searchUntil(app, utterance, params, itemCardsOf, 'itemCard 캐러셀');
}

/** 위와 같되 listCard 줄을 기다린다 (기본 카드 모양). */
export async function searchUntilRows(
  app: INestApplication,
  utterance: string,
  params: Record<string, unknown> = {},
): Promise<any[]> {
  return searchUntil(app, utterance, params, flightRowsOf, 'listCard');
}

async function searchUntil(
  app: INestApplication,
  utterance: string,
  params: Record<string, unknown>,
  pick: (body: any) => any[] | undefined,
  what: string,
): Promise<any[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await request(app.getHttpServer())
      .post(FLIGHTS)
      .send(kakaoPayload(utterance, 'test-user', params));
    const found = pick(res.body);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${what} 가 나오지 않았다: ${utterance}`);
}

// ------------------------------------------------------------------ 관광지
/**
 * 카드가 나올 때까지 다시 물어본다 (관광지).
 *
 * 캐시 미스는 즉시 카드를 주지 않는다 — 백그라운드 검색이 끝나야 캐시에 들어간다.
 */
export async function attractionsUntilCard(
  app: INestApplication,
  utterance: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await request(app.getHttpServer())
      .post(ATTRACTIONS)
      .send(kakaoPayload(utterance, 'test-user', params));
    const card = listCardOf(res.body);
    if (card) return card;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`listCard 가 나오지 않았다: ${utterance}`);
}

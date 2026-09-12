import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { createServer, Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { ATTRACTION_PROVIDER } from '../src/modules/attraction/attraction.types';
import { FLIGHT_PROVIDER } from '../src/modules/flight/flight.types';
import { HOTEL_PROVIDER } from '../src/modules/hotel/hotel.types';
import { IntentService } from '../src/modules/intent/intent.service';
import { OpenAiService } from '../src/modules/openai/openai.service';
import { PlacesService } from '../src/modules/places/places.service';
import { SearchService } from '../src/modules/search/search.service';
import { FakeAttractionProvider } from './fake-attraction-provider';
import { FakeFlightProvider } from './fake-flight-provider';
import { FakeHotelProvider } from './fake-provider';
import { FakeOpenAiService } from './fake-openai';

/** **유일한 진입점.** 호텔·항공권·관광지가 전부 여기로 온다. */
export const ROUTER = '/api/v1/kakao/router';

export interface TestApp {
  app: INestApplication;
  provider: FakeHotelProvider;
  flightProvider: FakeFlightProvider;
  attractionProvider: FakeAttractionProvider;
  openai: FakeOpenAiService;
  /** 캐시·별칭·의도 메모리를 한 번에 비운다. 테스트끼리 안 섞이게 하는 스위치. */
  reset(): void;
}

export async function createApp(): Promise<TestApp> {
  const provider = new FakeHotelProvider();
  const flightProvider = new FakeFlightProvider();
  const attractionProvider = new FakeAttractionProvider();
  const openai = new FakeOpenAiService();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // 실제 OpenAI 를 부르지 않는다 — 검색(provider)도, 발화 해석(OpenAiService)도.
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

  const search = app.get(SearchService);
  const places = app.get(PlacesService);
  const intent = app.get(IntentService);

  return {
    app,
    provider,
    flightProvider,
    attractionProvider,
    openai,
    reset() {
      search.clearMemory();
      places.clearMemory();
      intent.clearMemory();
      provider.reset();
      flightProvider.reset();
      attractionProvider.reset();
      openai.reset();
    },
  };
}

/**
 * 오픈빌더 폴백 블록이 보내는 페이로드.
 *
 * **엔티티가 없으므로 params 는 항상 비어 있다.** 지역은 발화에서만 나온다.
 * clientExtra 는 "더 보기" 버튼이 넘겨주는 유일한 구조화 데이터다.
 */
export function kakaoPayload(
  utterance: string,
  opts: {
    userKey?: string;
    clientExtra?: Record<string, unknown>;
    callbackUrl?: string;
    blockId?: string;
  } = {},
): Record<string, unknown> {
  const userKey = opts.userKey ?? 'test-user';
  const userRequest: Record<string, unknown> = {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: opts.blockId ?? 'fallback-block', name: '폴백 블록' },
    utterance,
    lang: 'kr',
    user: { id: userKey, type: 'botUserKey', properties: { botUserKey: userKey } },
  };
  // 오픈빌더에서 콜백을 켠 블록만 이 필드를 실어 보낸다.
  if (opts.callbackUrl) userRequest.callbackUrl = opts.callbackUrl;

  return {
    intent: { id: 'intent-1', name: '폴백 블록' },
    userRequest,
    bot: { id: 'bot-1', name: '여행메이트 TST' },
    action: {
      name: '폴백액션',
      clientExtra: opts.clientExtra ?? {},
      params: {},
      detailParams: {},
      id: 'action-1',
    },
  };
}

export const post = (app: INestApplication, body: Record<string, unknown>) =>
  request(app.getHttpServer()).post(ROUTER).send(body);

export const listCardOf = (body: any) =>
  body?.template?.outputs?.find((o: any) => o.listCard)?.listCard;

/** 카드 아래 고지 말풍선. 카드가 있으면 항상 따라온다. */
export const noticeOf = (body: any): string =>
  body?.template?.outputs?.find((o: any) => o.simpleText)?.simpleText?.text ?? '';

export const textOf = (body: any): string =>
  body?.template?.outputs?.[0]?.simpleText?.text ?? '';

export const moreButtonOf = (body: any) =>
  listCardOf(body)?.buttons?.find((b: any) => b.label === '더 보기');

/**
 * 카드가 나올 때까지 다시 물어본다.
 *
 * 캐시 미스는 즉시 카드를 주지 않는다 — 백그라운드 검색이 끝나야 저장된다.
 * 콜백을 안 쓰는 경로에서 "잠시 후 다시 물어보면 나온다" 가 실제로 되는지도 같이 검증된다.
 */
export async function askUntilCard(
  app: INestApplication,
  utterance: string,
  opts: Parameters<typeof kakaoPayload>[1] = {},
): Promise<any> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await post(app, kakaoPayload(utterance, opts));
    if (listCardOf(res.body)) return res.body;
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

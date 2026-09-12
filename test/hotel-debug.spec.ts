import { createHash } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { failureHint, keyFingerprint } from '../src/modules/hotel/hotel-debug.controller';
import { OpenAiHotelProvider } from '../src/modules/hotel/providers/openai.provider';
import { OpenAiService } from '../src/modules/openai/openai.service';
import { FakeOpenAiService } from './fake-openai';
import { defaultHotels } from './fake-provider';
import { listCardOf } from './helpers';

const ENDPOINT = '/api/v1/debug/hotel-search';
/** 카카오 사용자가 실제로 치는 문장. 도시명만 넘기는 게 아니다. */
const U = encodeURIComponent('오사카 여행갈건데 4명기준으로 숙소 추천해줘');

/**
 * 진단 엔드포인트는 호출 한 번이 곧 OpenAI 요금이고, /docs 는 운영에서 공개돼 있다.
 * 그래서 "누가 부를 수 있는가" 가 이 엔드포인트에서 제일 중요한 성질이다.
 */
describe('진단 엔드포인트 접근 제어', () => {
  const withEnv = async (
    env: Record<string, string>,
    run: (app: INestApplication) => Promise<void>,
  ) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    // 설정은 부팅 시 한 번 읽으므로 앱을 새로 세워야 한다.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await run(app);
    } finally {
      await app.close();
      process.env = saved;
    }
  };

  it('운영 + DEBUG_TOKEN 없음 → 404 (열려 있으면 아무나 요금을 태운다)', async () => {
    await withEnv({ APP_ENV: 'production', DEBUG_TOKEN: '' }, async (app) => {
      await request(app.getHttpServer())
        .get(`${ENDPOINT}?utterance=${U}`)
        .expect(404);
    });
  });

  it('DEBUG_TOKEN 설정 + 토큰 없음/틀림 → 401', async () => {
    await withEnv(
      { APP_ENV: 'production', DEBUG_TOKEN: 'secret' },
      async (app) => {
        await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}`)
          .expect(401);
        await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}`)
          .set('x-debug-token', 'wrong')
          .expect(401);
      },
    );
  });

  it('토큰이 맞으면 통과하고, trace 를 켜면 키가 없는 이유가 보인다', async () => {
    await withEnv(
      { APP_ENV: 'production', DEBUG_TOKEN: 'secret', OPENAI_API_KEY: '' },
      async (app) => {
        const res = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}&trace=1`)
          .set('x-debug-token', 'secret')
          .expect(200);

        // 스킬 엔드포인트는 이 상황에서도 "찾고 있어요" 만 준다. 여기서는 원인이 보여야 한다.
        expect(res.body.debug.ok).toBe(false);
        expect(res.body.debug.openai.enabled).toBe(false);
        expect(res.body.debug.hint).toContain('OPENAI_API_KEY');
        expect(res.body.debug.hotels).toEqual([]);
        expect(res.body.debug.timings.totalMs).toBeGreaterThanOrEqual(0);
        // 발화를 그대로 되돌려줘야 뭘 넣었는지 대조가 된다
        expect(res.body.debug.utterance).toBe(
          '오사카 여행갈건데 4명기준으로 숙소 추천해줘',
        );
      },
    );
  });

  it('로컬(APP_ENV != production)에서는 토큰 없이도 쓸 수 있다', async () => {
    await withEnv(
      { APP_ENV: 'local', DEBUG_TOKEN: '', OPENAI_API_KEY: '' },
      async (app) => {
        const res = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}&trace=1`)
          .expect(200);
        // 키가 없어도 사전에 있는 도시(오사카)는 파싱된다 — 검색만 못 한다.
        expect(res.body.debug.utterance).toContain('오사카');
        expect(res.body.debug.query.citySlug).toBe('osaka');
        expect(res.body.debug.hotels).toEqual([]);

        // 사전에 없는 도시는 모델이 유일한 수단이라 query 를 못 만든다.
        const unknown = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${encodeURIComponent('없는도시 호텔')}&trace=1`)
          .expect(200);
        expect(unknown.body.debug.query).toBeNull();
      },
    );
  });

  /**
   * 이 엔드포인트의 값어치는 "카카오가 받는 것과 같은가"에 달려 있다.
   * 진단 정보를 기본으로 섞으면 응답을 그대로 복사해 오픈빌더에 넣어볼 수 없다.
   */
  it('기본 응답은 스킬 응답 그 자체다 — 진단 정보가 섞이지 않는다', async () => {
    await withEnv(
      { APP_ENV: 'local', DEBUG_TOKEN: '', OPENAI_API_KEY: '' },
      async (app) => {
        const res = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}`)
          .expect(200);

        expect(res.body.version).toBe('2.0');
        expect(Array.isArray(res.body.template.outputs)).toBe(true);
        expect(res.body.template.outputs.length).toBeGreaterThan(0);
        expect(res.body.debug).toBeUndefined();
        // 진단용 최상위 키가 새어 나오면 안 된다
        expect(res.body.ok).toBeUndefined();
        expect(res.body.timings).toBeUndefined();
      },
    );
  });

  it('trace 를 켜도 스킬 응답은 그대로 두고 debug 만 얹는다', async () => {
    await withEnv(
      { APP_ENV: 'local', DEBUG_TOKEN: '', OPENAI_API_KEY: '' },
      async (app) => {
        const plain = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}`)
          .expect(200);
        const traced = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}&trace=true`)
          .expect(200);

        expect(traced.body.template).toEqual(plain.body.template);
        expect(traced.body.debug).toBeDefined();
      },
    );
  });

  it('utterance 가 없으면 404', async () => {
    await withEnv({ APP_ENV: 'local', DEBUG_TOKEN: '' }, async (app) => {
      await request(app.getHttpServer()).get(ENDPOINT).expect(404);
    });
  });
});

describe('OpenAI 실패를 고칠 수 있는 말로 옮긴다', () => {
  it('모델 접근 권한 — 배포로는 안 고쳐지는 문제라 확인 방법을 알려줘야 한다', () => {
    const hint = failureHint(
      'openai HTTP 403: {"error":{"message":"Project `proj_abc` does not have access to model `gpt-5-mini`","code":"model_not_found"}}',
    );
    expect(hint).toContain('gpt-5-mini');
    expect(hint).toContain('sha256'); // 키 대조 방법을 제시해야 한다
  });

  it('키·한도·타임아웃을 구분한다', () => {
    expect(failureHint('openai HTTP 401: invalid_api_key')).toContain('OPENAI_API_KEY');
    expect(failureHint('openai HTTP 429: insufficient_quota')).toContain('크레딧');
    expect(failureHint('openai timeout after 60000ms')).toContain('OPENAI_TIMEOUT_SECONDS');
  });

  it('모르는 에러는 원문을 그대로 보여준다', () => {
    expect(failureHint('ECONNREFUSED 127.0.0.1:443')).toContain('ECONNREFUSED');
  });
});

describe('키 지문 — 키를 노출하지 않고 대조만 가능하게', () => {
  const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

  it('키 값이 응답 어디에도 안 들어간다', () => {
    const fp = keyFingerprint(KEY);
    expect(JSON.stringify(fp)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(fp)).not.toContain(KEY);
  });

  it('같은 키는 같은 지문, 다른 키는 다른 지문', () => {
    expect(keyFingerprint(KEY)).toEqual(keyFingerprint(KEY));
    expect(keyFingerprint(KEY).sha256).not.toBe(keyFingerprint(KEY + 'x').sha256);
  });

  it('셸에서 뽑는 값과 같은 방식이어야 대조가 된다', () => {
    const expected = createHash('sha256').update(KEY, 'utf8').digest('hex').slice(0, 12);
    expect(keyFingerprint(KEY).sha256).toBe(expected);
  });

  it('프로젝트 키인지 알려준다', () => {
    expect(keyFingerprint(KEY).prefix).toBe('sk-proj-');
    expect(keyFingerprint('sk-legacy123').prefix).toBe('sk-');
  });

  it('키가 없으면 present:false', () => {
    expect(keyFingerprint('')).toEqual({ present: false });
  });
});

/**
 * 이 엔드포인트의 존재 이유는 "카카오가 실제로 받는 걸 미리 본다"는 것이다.
 * 비슷하게 생긴 걸 따로 만들어 보여주면 아무것도 검증하지 못한다.
 *
 * 진단 컨트롤러는 HOTEL_PROVIDER 토큰이 아니라 OpenAiHotelProvider 를 직접 쓴다
 * (단계별 계측이 필요해서). 그래서 여기서는 그쪽을 덮어쓴다.
 */
describe('진단 응답 = 스킬이 내보내는 카드', () => {
  const TRACE = {
    searchMs: 10,
    rankMs: 5,
    thumbnailMs: 0,
    totalMs: 15,
    searchCalls: 2,
    candidateChars: 100,
    candidates: 6,
    picks: 6,
    droppedUntrusted: 0,
    droppedThumbnails: 0,
    hotels: 6,
  };

  let app: INestApplication;

  beforeAll(async () => {
    process.env.APP_ENV = 'local';
    process.env.DEBUG_TOKEN = '';
    process.env.OPENAI_API_KEY = 'sk-test';

    // searchTraced 만 있으면 된다 — 컨트롤러가 부르는 건 그것뿐이다.
    const fake = {
      name: 'fake',
      searchTraced: async (query: any) => ({
        hotels: defaultHotels(query),
        trace: TRACE,
        candidates: '[]',
      }),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OpenAiService)
      .useValue(new FakeOpenAiService())
      .overrideProvider(OpenAiHotelProvider)
      .useValue(fake)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const search = (extra = '') =>
    request(app.getHttpServer())
      .get(`${ENDPOINT}?utterance=${U}${extra}`)
      .expect(200);

  it('listCard 가 스킬 경로와 똑같이 조립된다 (5줄 제한 포함)', async () => {
    const res = await search();
    const card = listCardOf(res.body);

    expect(card).toBeDefined();
    expect(card.header.title).toBe('오사카 호텔 추천 5곳');
    // provider 는 6곳을 주지만 listCard 는 5줄이 한계다
    expect(card.items).toHaveLength(5);
    expect(card.buttons[0].label).toBe('다른 도시 보기');
    expect(res.body.template.quickReplies.length).toBeGreaterThan(0);
  });

  it('줄 링크가 우리 리다이렉트를 가리키고, 실제로 302 가 난다', async () => {
    const res = await search();
    const card = listCardOf(res.body);

    for (const item of card.items) {
      expect(item.link.web).toMatch(/\/r\/[\w-]+$/);
    }

    // 진단 호출은 통계를 남기지 않지만 clickId 는 인메모리에 남는다.
    // 그래서 카드를 받아 그대로 눌러보는 것까지 여기서 확인된다.
    const clickId = String(card.items[0].link.web).split('/r/')[1];
    await request(app.getHttpServer()).get(`/r/${clickId}`).expect(302);
  });

  it('trace 를 켜면 카드는 그대로 두고 진단만 얹는다', async () => {
    const plain = await search();
    const traced = await search('&trace=1');

    // 카드 본문은 손대지 않는다 (clickId 는 매번 새로 발급되므로 구조만 비교)
    expect(Object.keys(traced.body)).toEqual([...Object.keys(plain.body), 'debug']);
    expect(traced.body.debug.ok).toBe(true);
    expect(traced.body.debug.counts.hotels).toBe(6);
    expect(traced.body.debug.query.cityName).toBe('오사카');
    expect(traced.body.debug.parsed.guests).toBe(4);
  });
});

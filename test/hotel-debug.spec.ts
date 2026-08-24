import { createHash } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { failureHint, keyFingerprint } from '../src/modules/hotel/hotel-debug.controller';

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

  it('토큰이 맞으면 통과하고, 키가 없으면 ok:false 로 이유를 알려준다', async () => {
    await withEnv(
      { APP_ENV: 'production', DEBUG_TOKEN: 'secret', OPENAI_API_KEY: '' },
      async (app) => {
        const res = await request(app.getHttpServer())
          .get(`${ENDPOINT}?utterance=${U}`)
          .set('x-debug-token', 'secret')
          .expect(200);

        // 스킬 엔드포인트는 이 상황에서도 "찾고 있어요" 만 준다. 여기서는 원인이 보여야 한다.
        expect(res.body.ok).toBe(false);
        expect(res.body.openai.enabled).toBe(false);
        expect(res.body.hint).toContain('OPENAI_API_KEY');
        expect(res.body.hotels).toEqual([]);
        expect(res.body.timings.totalMs).toBeGreaterThanOrEqual(0);
        // 발화를 그대로 되돌려줘야 뭘 넣었는지 대조가 된다
        expect(res.body.utterance).toBe(
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
          .get(`${ENDPOINT}?utterance=${U}`)
          .expect(200);
        // 키가 없으니 파싱을 못 한다 — query 는 못 만들고 발화만 돌아온다
        expect(res.body.utterance).toContain('오사카');
        expect(res.body.query).toBeNull();
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

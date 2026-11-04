import { AppConfig, loadConfig } from '../src/config/app.config';
import { HealthController } from '../src/modules/health/health.controller';
import {
  OpenAiHttpError,
  OpenAiService,
  isCredentialError,
} from '../src/modules/openai/openai.service';

/**
 * 자격증명 거부(401·403)를 **다른 실패와 다르게 다룬다.**
 *
 * 2026-11-04 에 서버 `.env` 의 키가 꼬리 한 글자가 붙은 채 저장돼 모든 검색이 401 이었다.
 * 그동안 `/health` 는 `ok` 를 답했고(값이 비었는지만 봤다), 사용자는 "잠시 뒤 다시
 * 시도해 주세요" 를 받았다 — 키를 고치기 전엔 영영 안 되는 안내다. 원인을 짚는 데
 * 한참 걸렸고, 그 두 가지가 여기서 막힌다.
 */

const KEY = 'sk-test-key';

function build(over: Partial<AppConfig> = {}): OpenAiService {
  const config = {
    ...loadConfig(),
    openaiApiKey: KEY,
    openaiApiBase: 'https://api.test/v1',
    openaiModel: 'gpt-5.6-luna',
    ...over,
  };
  return new OpenAiService(config);
}

const ask = (svc: OpenAiService) => svc.respond({ model: 'gpt-5.6-luna', input: '안녕' });

/** 정상 응답 한 건. */
const ok = () =>
  new Response(
    JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const fail = (status: number) =>
  new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status });

describe('OpenAI 자격증명 거부', () => {
  let calls: number;
  let next: () => Response;
  let now: number;
  const realFetch = global.fetch;
  const realNow = Date.now;

  beforeEach(() => {
    calls = 0;
    next = ok;
    now = 1_700_000_000_000;
    Date.now = () => now;
    global.fetch = async () => {
      calls += 1;
      return next();
    };
  });

  afterEach(() => {
    global.fetch = realFetch;
    Date.now = realNow;
  });

  it('401 이면 호출을 멈추고 거부 상태로 남는다', async () => {
    const svc = build();
    expect(svc.enabled).toBe(true);

    next = () => fail(401);
    await expect(ask(svc)).rejects.toThrow(OpenAiHttpError);

    expect(svc.enabled).toBe(false);
    expect(svc.status).toBe('rejected');
    expect(svc.credentialHttpCode).toBe(401);
    // 키는 채워져 있다. "없다" 와 "안 먹는다" 는 다른 상태다.
    expect(svc.configured).toBe(true);
  });

  it('403 도 같다 — 프로젝트·조직 헤더가 키와 안 맞는 경우다', async () => {
    const svc = build();
    next = () => fail(403);
    await expect(ask(svc)).rejects.toThrow(OpenAiHttpError);
    expect(svc.status).toBe('rejected');
    expect(svc.credentialHttpCode).toBe(403);
  });

  /**
   * ⚠️ **돈이 걸린 줄이다.** 웹 검색이 붙은 호출은 한 번에 25초 + 호출료다.
   *    401 은 다시 시도해도 같은 답이라, 쿨다운 동안은 네트워크를 타면 안 된다.
   */
  it('거부된 동안에는 네트워크를 타지 않는다', async () => {
    const svc = build();
    next = () => fail(401);
    await expect(ask(svc)).rejects.toThrow();
    expect(calls).toBe(1);

    await expect(ask(svc)).rejects.toThrow(OpenAiHttpError);
    await expect(ask(svc)).rejects.toThrow(OpenAiHttpError);
    expect(calls).toBe(1); // 늘지 않았다
  });

  /** 키를 고친 뒤 컨테이너 재시작을 강요하지 않는다. */
  it('쿨다운이 지나면 스스로 다시 시도한다', async () => {
    const svc = build();
    next = () => fail(401);
    await expect(ask(svc)).rejects.toThrow();
    expect(svc.enabled).toBe(false);

    now += 5 * 60 * 1000 + 1;
    expect(svc.enabled).toBe(true);

    next = ok;
    await ask(svc);
    expect(svc.status).toBe('ok');
    expect(calls).toBe(2);
  });

  it('한 번 성공하면 거부 기록이 지워진다', async () => {
    const svc = build();
    next = () => fail(401);
    await expect(ask(svc)).rejects.toThrow();

    now += 5 * 60 * 1000 + 1;
    next = ok;
    await ask(svc);

    expect(svc.status).toBe('ok');
    expect(svc.enabled).toBe(true);
    expect(svc.credentialHttpCode).toBe(0);
  });

  /** 모델 오류·혼잡은 지나간다. 그걸로 서비스를 내리면 안 된다. */
  it('500 · 429 는 거부로 치지 않는다', async () => {
    for (const status of [429, 500, 503]) {
      const svc = build();
      next = () => fail(status);
      await expect(ask(svc)).rejects.toThrow();
      expect(svc.enabled).toBe(true);
      expect(svc.status).toBe('ok');
    }
  });

  it('키가 아예 없으면 거부가 아니라 미설정이다', async () => {
    const svc = build({ openaiApiKey: '' });
    expect(svc.status).toBe('no-key');
    expect(svc.enabled).toBe(false);
    await expect(ask(svc)).rejects.toThrow('OPENAI_API_KEY');
    expect(calls).toBe(0);
  });
});

describe('isCredentialError', () => {
  it('401 · 403 만 참이다', () => {
    expect(isCredentialError(new OpenAiHttpError(401, ''))).toBe(true);
    expect(isCredentialError(new OpenAiHttpError(403, ''))).toBe(true);
    expect(isCredentialError(new OpenAiHttpError(400, ''))).toBe(false);
    expect(isCredentialError(new OpenAiHttpError(429, ''))).toBe(false);
    expect(isCredentialError(new OpenAiHttpError(500, ''))).toBe(false);
    expect(isCredentialError(new Error('그냥 오류'))).toBe(false);
    expect(isCredentialError(null)).toBe(false);
  });
});

describe('/health 의 openai 칸', () => {
  /**
   * ⚠️ **"채워졌나" 가 아니라 "먹히나" 를 답해야 한다.** 2026-11-04 에 401 이 쏟아지는
   *    동안 이 칸은 모델명을 찍고 있었다 — 운영에는 아무 신호가 없었다.
   */
  const field = (status: 'ok' | 'no-key' | 'rejected', code = 0): string => {
    const config = { appEnv: 'test', openaiModel: 'gpt-5.6-luna' } as never;
    const domain = { providerName: 'fake' } as never;
    const openai = { status, credentialHttpCode: code } as never;
    const body = new HealthController(
      config,
      {} as never,
      domain,
      domain,
      domain,
      openai,
    ).health();
    return String(body.openai);
  };

  it('정상이면 모델명', () => {
    expect(field('ok')).toBe('gpt-5.6-luna');
  });

  it('키가 거부되면 rejected 와 HTTP 코드를 드러낸다', () => {
    const text = field('rejected', 401);
    expect(text).toContain('rejected');
    expect(text).toContain('401');
    expect(text).toContain('OPENAI_API_KEY');
  });

  it('키가 없으면 그렇게 말한다 — 거부와 다른 상태다', () => {
    expect(field('no-key')).toBe('disabled(no key)');
  });

  /** liveness 다. 키가 틀렸다고 컨테이너를 재시작해봐야 키는 그대로다. */
  it('거부 상태여도 status 는 ok 다', () => {
    const config = { appEnv: 'test', openaiModel: 'gpt-5.6-luna' } as never;
    const domain = { providerName: 'fake' } as never;
    const openai = { status: 'rejected', credentialHttpCode: 401 } as never;
    const body = new HealthController(config, {} as never, domain, domain, domain, openai).health();
    expect(body.status).toBe('ok');
  });
});

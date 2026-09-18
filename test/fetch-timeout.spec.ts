import { FetchTimeoutError, fetchWithTimeout } from '../src/common/fetch';

/**
 * 타임아웃이 걸린 fetch.
 *
 * 지키려는 건 하나다 — **시계가 응답 본문을 다 읽을 때까지 돈다.** 각자 세우던
 * AbortController 를 걷어낸 이유가 이것이고, 이게 깨지면 헤더만 주고 본문을 안 주는
 * 상대에게 무한정 붙잡힌다.
 */

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

/** signal 을 존중하는 가짜 fetch. 실제 abort 처럼 signal 이 끊기면 거부한다. */
function stubFetch(handler: (signal: AbortSignal) => Promise<Response>) {
  globalThis.fetch = (_url: unknown, init?: RequestInit) => handler(init!.signal!);
}

/** signal 이 끊길 때까지 영원히 기다린다. */
function never(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

describe('fetchWithTimeout', () => {
  it('정상 응답은 read 가 만든 값을 그대로 돌려준다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ hello: 'world' }) }) as Response);

    const body = await fetchWithTimeout('https://example.com', {}, 1000, (res) => res.json());

    expect(body).toEqual({ hello: 'world' });
  });

  it('연결이 안 되면 FetchTimeoutError 로 끊는다', async () => {
    stubFetch((signal) => never(signal));

    await expect(fetchWithTimeout('https://example.com', {}, 30, () => Promise.resolve(1)))
      .rejects.toBeInstanceOf(FetchTimeoutError);
  });

  // ⚠️ 이 테스트가 이 파일의 이유다. clearTimeout 을 fetch 직후로 옮기면 여기서 걸린다.
  it('**본문을 읽는 동안에도 시계가 돈다** — 헤더만 주고 버티는 상대에게 안 붙잡힌다', async () => {
    stubFetch(
      async (signal) =>
        ({
          ok: true,
          // 헤더는 즉시 왔지만 본문이 영영 안 온다.
          json: () => never(signal),
        }) as unknown as Response,
    );

    await expect(
      fetchWithTimeout('https://example.com', {}, 30, (res) => res.json()),
    ).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it('상대가 거절한 것은 타임아웃으로 바꾸지 않는다 — 원인이 다르면 대응도 다르다', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(
      fetchWithTimeout('https://example.com', {}, 1000, () => Promise.resolve(1)),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('read 가 던진 예외는 그대로 올라간다 (HTTP 4xx·5xx 판정이 여기 산다)', async () => {
    stubFetch(async () => ({ ok: false, status: 429 }) as Response);

    await expect(
      fetchWithTimeout('https://example.com', {}, 1000, (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Promise.resolve(1);
      }),
    ).rejects.toThrow('HTTP 429');
  });

  it('성공해도 타이머를 정리한다 — 안 그러면 프로세스가 안 죽는다', async () => {
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    stubFetch(async () => ({ ok: true, json: async () => ({}) }) as Response);

    await fetchWithTimeout('https://example.com', {}, 1000, (res) => res.json());

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

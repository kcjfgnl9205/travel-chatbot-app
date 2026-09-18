/**
 * 타임아웃이 걸린 fetch.
 *
 * 여섯 군데가 같은 네 줄(AbortController · setTimeout · signal · finally clearTimeout)을
 * 각자 들고 있었다. 줄 수보다 중요한 건 **그 네 줄에 지키기 쉬운 순서가 아닌 규칙이
 * 하나 숨어 있다**는 것이다 —
 *
 * ⚠️ **시계는 응답 본문을 다 읽을 때까지 돈다.**
 *    `clearTimeout` 을 fetch 직후에 두면 아주 자연스러워 보이는데, 그러면 헤더만 주고
 *    본문을 찔끔찔끔 흘리는 상대에게 무한정 붙잡힌다. 카카오 5초 예산 안에서 도는
 *    호출이 섞여 있으므로 그건 그냥 장애다.
 *
 *    그래서 읽기를 `read` 콜백으로 받는다. 타이머를 언제 끄는지 호출부가 고를 수 없게
 *    만드는 것이 이 헬퍼의 요점이다 — Response 를 그대로 돌려주면 다시 각자 판단하게
 *    되고, 그 판단은 여섯 번 중 한 번은 틀린다.
 */
export async function fetchWithTimeout<T>(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await read(res);
  } catch (err) {
    // 시간이 다 돼서 우리가 끊은 것과 상대가 거절한 것은 원인이 달라 대응도 다르다.
    // 구별하지 않으면 로그에 "This operation was aborted" 만 남아 아무것도 알 수 없다.
    if (controller.signal.aborted) throw new FetchTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 상대가 거절한 게 아니라 **우리가 기다리다 끊었다**는 뜻. */
export class FetchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

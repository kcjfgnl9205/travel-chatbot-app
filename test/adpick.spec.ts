import {
  AdpickService,
  STATUS_FALLBACK,
  STATUS_OK,
  applySubid,
  pDataFor,
  renderTemplate,
} from '../src/modules/adpick/adpick.service';
import { AppConfig, loadConfig } from '../src/config/app.config';

const SOURCE = 'https://www.agoda.com/ko-kr/hotel/12345.html?cid=1';
const API_KEY = 'TESTKEY123';

function config(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig(), adpickLinkTemplate: '', ...over };
}
const apiConfig = (over: Partial<AppConfig> = {}) => config({ adpickApiKey: API_KEY, ...over });

/** fetch 를 갈아끼워 실제 애드픽을 타지 않게 한다. */
function stubFetch(handler: (url: URL) => unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const result = handler(url);
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => result } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('애드픽 커미션 링크', () => {
  // ------------------------------------------------------------ 순수 함수
  it('p_data 는 같은 주소면 항상 같고 스펙(50자) 안에 든다', () => {
    const first = pDataFor(SOURCE);
    expect(pDataFor(SOURCE)).toBe(first); // 링크 재사용의 전제
    expect(pDataFor(SOURCE + 'x')).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(50);
  });

  it('템플릿은 원본 주소를 URL 인코딩한다', () => {
    const url = renderTemplate(
      'https://adpick.test/c/AB12?url={source_url}&subid={click_id}',
      SOURCE,
      'CLICK1',
    );
    expect(url).toContain('url=https%3A%2F%2Fwww.agoda.com%2Fko-kr%2Fhotel%2F12345.html%3Fcid%3D1');
    expect(url).toContain('subid=CLICK1');
  });

  it('subid 는 기본 비활성 — 애드픽 링크는 임의 파라미터를 해석하지 않는다', () => {
    expect(applySubid('https://link.adpick.co.kr/abc', 'CLICK1', config())).toBe(
      'https://link.adpick.co.kr/abc',
    );
  });

  it('subid 를 명시적으로 켜면 붙는다', () => {
    const url = applySubid(
      'https://other.test/c?utm=kakao',
      'CLICK1',
      config({ adpickSubidParam: 'subid' }),
    );
    expect(url).toContain('subid=CLICK1');
    expect(url).toContain('utm=kakao');
  });

  // ------------------------------------------------------------ API 호출
  it('문서에 적힌 엔드포인트로 호출한다', async () => {
    let seen: URL | null = null;
    const restore = stubFetch((url) => {
      seen = url;
      return {
        success: true,
        data: { status: 'success', commissionlink: 'https://link.adpick.co.kr/xxxxxxxx' },
      };
    });

    const result = await new AdpickService(apiConfig()).convert(SOURCE, 'agoda');
    restore();

    expect(seen!.origin + seen!.pathname).toBe(`https://biz.adpick.co.kr/api/${API_KEY}/link`);
    expect(seen!.searchParams.get('url')).toBe(SOURCE);
    expect(seen!.searchParams.get('p_data')).toBe(pDataFor(SOURCE));
    expect(seen!.searchParams.has('linkonly')).toBe(false); // 기본값 true 는 안 보냄

    expect(result.status).toBe(STATUS_OK);
    expect(result.affiliateUrl).toBe('https://link.adpick.co.kr/xxxxxxxx');
  });

  it('linkonly=false 면 상품정보를 함께 담는다', async () => {
    let seen: URL | null = null;
    const restore = stubFetch((url) => {
      seen = url;
      return {
        success: true,
        data: {
          status: 'success',
          commissionlink: 'https://link.adpick.co.kr/yyyy',
          cp_name: '아고다',
          commission_per: '3.0',
        },
      };
    });

    const result = await new AdpickService(apiConfig({ adpickLinkonly: false })).convert(SOURCE);
    restore();

    expect(seen!.searchParams.get('linkonly')).toBe('false');
    expect(result.merchantName).toBe('아고다');
    expect(result.commissionPer).toBe(3.0);
  });

  it('API 가 죽어도 링크는 만들어진다', async () => {
    const restore = stubFetch(() => new Error('timeout'));
    const result = await new AdpickService(
      apiConfig({ adpickLinkTemplate: 'https://adpick.test/c/AB12?url={source_url}' }),
    ).convert(SOURCE);
    restore();

    expect(result.affiliateUrl).toMatch(/^https:\/\/adpick\.test\/c\/AB12/);
    expect(result.error).toContain('timeout');
  });

  it('API 키가 error 필드로 새지 않는다', async () => {
    // 애드픽은 키가 URL 경로에 들어간다(/api/{apikey}/link).
    // 예외 메시지에 요청 URL 이 담기므로 가리지 않으면 DB(affiliate_links.error)에 남는다.
    const restore = stubFetch(
      () => new Error(`Client error 403 for url 'https://biz.adpick.co.kr/api/${API_KEY}/link'`),
    );
    const result = await new AdpickService(apiConfig()).convert(SOURCE);
    restore();

    expect(result.error).not.toContain(API_KEY);
    expect(result.error).toContain('***');
    expect(result.affiliateUrl).toBe(SOURCE); // 그래도 사용자는 호텔로 간다
  });

  it('commissionlink 가 없으면 원본 주소로 폴백한다', async () => {
    const restore = stubFetch(() => ({ success: false, message: '잘못된 URL' }));
    const result = await new AdpickService(apiConfig()).convert(SOURCE);
    restore();

    expect(result.affiliateUrl).toBe(SOURCE);
    expect(result.error).toBe('잘못된 URL');
  });

  // ------------------------------------------------------------ 폴백
  it('키가 없으면 템플릿을 쓴다', async () => {
    const result = await new AdpickService(
      config({ adpickApiKey: '', adpickLinkTemplate: 'https://adpick.test/c/AB12?url={source_url}' }),
    ).convert(SOURCE);
    expect(result.status).toBe(STATUS_FALLBACK);
    expect(result.affiliateUrl).toMatch(/^https:\/\/adpick\.test\/c\/AB12/);
  });

  it('키도 템플릿도 없으면 원본 주소로 간다', async () => {
    const result = await new AdpickService(config({ adpickApiKey: '' })).convert(SOURCE);
    expect(result.affiliateUrl).toBe(SOURCE);
  });

  it('빈 주소는 거절한다', async () => {
    const result = await new AdpickService(apiConfig()).convert('');
    expect(result.affiliateUrl).toBeNull();
  });
});

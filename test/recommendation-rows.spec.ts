import { ResolvedLink } from '../src/modules/affiliate/affiliate.service';
import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import {
  ItemRow,
  RecommendationRowsService,
} from '../src/modules/recommendation/rows.service';
import { RenderContext } from '../src/modules/search/search.types';
import { AppConfig, loadConfig } from '../src/config/app.config';

/**
 * 세 도메인이 공유하는 노출 기록·링크 발급.
 *
 * 여기서 지키려는 건 **`links` 를 안 넘긴 도메인(관광지)과 넘겼는데 비어 있는 경우를
 * 구별하는 것**이다. 둘을 같이 취급하면 관광지 지도 링크에 추적 파라미터가 붙고,
 * "변환 실패" 경고가 관광지에서도 떠서 아무도 그 경고를 안 읽게 된다.
 */

function config(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig(), publicBaseUrl: 'https://bot.example.com', ...over };
}

/** DB 에 들어갈 뻔한 행을 가로챈다. 카드 JSON 만 봐서는 기록이 맞는지 알 수 없다. */
function fakes() {
  const inserted: Record<string, unknown>[][] = [];
  const recommendations = {
    create: async () => ({ id: 'rec-1' }),
  } as never;
  const items = {
    createMany: async (rows: Record<string, unknown>[]) => {
      inserted.push(rows);
      return [];
    },
  } as never;
  return { inserted, recommendations, items };
}

function build(over: Partial<AppConfig> = {}) {
  const { inserted, recommendations, items } = fakes();
  const memory = new MemoryStoreService();
  const service = new RecommendationRowsService(config(over), recommendations, items, memory);
  return { service, inserted, memory };
}

const CTX: RenderContext = {
  meta: { kind: 'attraction', placeName: '오사카', placeSlug: 'osaka' },
  userId: null,
  messageId: null,
  started: Date.now(),
  cacheHit: false,
};

const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=오사카성';

function item(over: Partial<ItemRow> = {}): ItemRow {
  return {
    label: '오사카성',
    sourceUrl: MAP_URL,
    title: '오사카성',
    description: '역사/문화 · 30분',
    ...over,
  };
}

describe('노출 기록 + 클릭 링크 발급', () => {
  it('줄 링크는 최종 목적지가 아니라 우리 리다이렉트를 가리킨다', async () => {
    const { service, inserted } = build();

    const rows = await service.render([item()], CTX, { provider: 'openai' });

    expect(rows).toHaveLength(1);
    const link = (rows[0] as { link: { web: string } }).link.web;
    expect(link).toMatch(/^https:\/\/bot\.example\.com\/r\/.+/);
    // 링크에 박힌 clickId 가 곧 DB 행의 click_id 여야 리다이렉트가 이어진다.
    expect(link.endsWith(String(inserted[0][0].click_id))).toBe(true);
  });

  // ------------------------------------------------------- 도메인별 스냅샷
  describe('도메인별로 남는 값', () => {
    it('행에 domain 이 박힌다 — 집계할 때 부모를 조인하지 않으려고', async () => {
      const { service, inserted } = build();

      await service.render([item()], CTX, { provider: 'openai' });

      expect(inserted[0][0].domain).toBe('attraction');
    });

    it('도메인 고유 값은 item_meta 로 간다', async () => {
      const { service, inserted } = build();

      await service.render(
        [item({ meta: { admissionFee: 1200, admissionCurrency: 'JPY', category: '역사/문화' } })],
        CTX,
        { provider: 'openai' },
      );

      expect(inserted[0][0].item_meta).toEqual({
        admissionFee: 1200,
        admissionCurrency: 'JPY',
        category: '역사/문화',
      });
    });

    /**
     * AI 결과는 필드가 비어 오는 게 흔하다. 그대로 담으면 null 만 든 행이 쌓인다.
     */
    it('빈 값은 키째로 빠진다', async () => {
      const { service, inserted } = build();

      await service.render(
        [item({ meta: { admissionFee: null, durationMinutes: undefined, category: '전망' } })],
        CTX,
        { provider: 'openai' },
      );

      expect(inserted[0][0].item_meta).toEqual({ category: '전망' });
    });

    /** ⚠️ 직항이 0 이다. 빈 값이라고 지우면 "직항" 이라는 정보가 통째로 사라진다. */
    it('0 과 false 는 값이므로 남는다', async () => {
      const { service, inserted } = build();

      await service.render([item({ meta: { stops: 0, free: false } })], CTX, {
        provider: 'openai',
      });

      expect(inserted[0][0].item_meta).toEqual({ stops: 0, free: false });
    });

    it('meta 를 안 넘기는 도메인은 빈 객체다', async () => {
      const { service, inserted } = build();

      await service.render([item()], CTX, { provider: 'openai' });

      expect(inserted[0][0].item_meta).toEqual({});
    });
  });

  // ------------------------------------------------- links 를 안 넘기는 도메인 (관광지)
  describe('제휴 변환을 다루지 않는 도메인', () => {
    it('목적지는 원본 주소 그대로이고 subid 를 붙이지 않는다', async () => {
      // subid 를 켜둔 설정에서도 붙으면 안 된다 — 지도 주소에 달아봐야 아무도 안 읽는다.
      const { service, inserted } = build({ adpickSubidParam: 'subid' });

      await service.render([item()], CTX, { provider: 'openai' });

      const row = inserted[0][0];
      expect(row.target_url).toBe(MAP_URL);
      expect(row.source_url).toBe(MAP_URL);
      expect(row.affiliate_link_id).toBeNull();
    });

    it('변환 실패로 세지 않는다 — 변환할 게 애초에 없다', async () => {
      const { service } = build();
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.render([item()], CTX, { provider: 'openai' });

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // ------------------------------------------------- links 를 넘기는 도메인 (호텔·항공권)
  describe('제휴 변환을 다루는 도메인', () => {
    const BOOKING = 'https://kr.trip.com/hotels/osaka-detail-1/';
    const hotel = item({ label: '호텔 A', sourceUrl: BOOKING, title: '호텔 A' });

    it('변환된 링크가 목적지가 되고 affiliate_link_id 가 남는다', async () => {
      const { service, inserted } = build();
      const links = new Map<string, ResolvedLink>([
        [
          BOOKING,
          {
            sourceUrl: BOOKING,
            affiliateUrl: 'https://link.adpick.co.kr/abcd',
            affiliateLinkId: 'link-1',
            status: 'ok',
            fromCache: false,
          },
        ],
      ]);

      await service.render([hotel], CTX, { provider: 'openai', links });

      const row = inserted[0][0];
      expect(row.target_url).toBe('https://link.adpick.co.kr/abcd');
      expect(row.affiliate_link_id).toBe('link-1');
      // 원본은 DB 에만 남는다 — 사용자에게 나가는 건 리다이렉트뿐이다.
      expect(row.source_url).toBe(BOOKING);
    });

    it('빈 Map 은 "변환을 못 했다" 이므로 경고를 남긴다', async () => {
      const { service, inserted } = build();
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.render([hotel], CTX, {
        provider: 'openai',
        links: new Map<string, ResolvedLink>(),
      });

      expect(inserted[0][0].target_url).toBe(BOOKING);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('애드픽 변환 실패 1/1건'));
      warn.mockRestore();
    });

    it('subid 를 설정했으면 목적지에 붙는다', async () => {
      const { service, inserted } = build({ adpickSubidParam: 'subid' });

      await service.render([hotel], CTX, {
        provider: 'openai',
        links: new Map<string, ResolvedLink>(),
      });

      const target = String(inserted[0][0].target_url);
      expect(target).toContain('subid=');
      expect(target).toContain(String(inserted[0][0].click_id));
    });
  });

  // ------------------------------------------------------------------ 공통
  it('DB 가 없어도 리다이렉트가 살도록 인메모리에도 남긴다', async () => {
    const { service, inserted, memory } = build();

    await service.render([item()], CTX, { provider: 'openai' });

    const clickId = String(inserted[0][0].click_id);
    expect(memory.get(clickId)?.targetUrl).toBe(MAP_URL);
  });

  it('persist:false 면 통계를 남기지 않는다 (진단 경로)', async () => {
    const { service, inserted } = build();

    const rows = await service.render([item()], { ...CTX, persist: false }, { provider: 'openai' });

    // 카드는 그대로 나오지만 recommendation_items 는 비어 있다.
    expect(rows).toHaveLength(1);
    expect(inserted).toHaveLength(0);
  });
});

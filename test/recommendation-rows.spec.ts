import { ResolvedLink } from '../src/modules/affiliate/affiliate.service';
import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import {
  ItemRow,
  RecommendationRowsService,
} from '../src/modules/recommendation/rows.service';
import { RenderContext } from '../src/modules/search/search.types';
import { AppConfig, loadConfig } from '../src/config/app.config';

/**
 * 호텔·항공권이 공유하는 노출 기록·링크 발급.
 *
 * 여기서 지키려는 건 **`links` 를 안 넘긴 경우와 넘겼는데 비어 있는 경우를 구별하는
 * 것**이다. 둘을 같이 취급하면 변환을 안 타는 주소에 추적 파라미터가 붙고,
 * "변환 실패" 경고가 그쪽에서도 떠서 아무도 그 경고를 안 읽게 된다.
 *
 * ⚠️ **관광지는 이 서비스를 안 탄다.** 0012 부터 노출 행 대신 `attractions` 의
 *    카운터를 올린다 ([attraction-counters.spec.ts](./attraction-counters.spec.ts)).
 *    그래서 `links` 를 안 넘기는 도메인이 지금은 없지만, 그 갈래는 남겨둔다 —
 *    제휴를 안 타는 도메인이 다시 생겼을 때 조용히 subid 가 붙으면 안 된다.
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
      return rows;
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
  meta: { kind: 'hotel', placeName: '오사카', placeSlug: 'osaka' },
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

  // ------------------------------------------------------------- 한 행에 다 담는다
  describe('노출 한 건이 곧 한 행이다', () => {
    it('공통 행에 domain 이 박힌다 — 집계할 때 부모를 조인하지 않으려고', async () => {
      const { service, inserted } = build();

      await service.render([item()], CTX, { provider: 'openai' });

      expect(inserted[0][0].domain).toBe('hotel');
    });

    /**
     * 0007 이 갈라뒀던 값들이 0013 에서 공통 테이블로 올라왔다.
     * **위성 insert 가 더 없다** — 노출 한 건에 쓰기 한 번이다.
     */
    it('가격·판매처·사진이 같은 행에 들어간다', async () => {
      const { service, inserted } = build();

      await service.render(
        [item({ price: 120000, merchant: 'trip', imageUrl: 'https://img/h.jpg' })],
        CTX,
        { provider: 'openai' },
      );

      expect(inserted).toHaveLength(1);
      expect(inserted[0][0]).toMatchObject({
        price: 120000,
        merchant: 'trip',
        image_url: 'https://img/h.jpg',
      });
    });

    /**
     * ⚠️ **같은 칸에 뜻이 다른 값이 들어간다** — 호텔 1박가 / 항공권 1인 총액.
     *    0013 이 두 칸을 합치면서 생긴 성질이라, 가르는 것은 domain 뿐이다.
     */
    it('항공권 총액도 같은 price 칸에 들어간다 — 구별은 domain 이 한다', async () => {
      const { service, inserted } = build();
      const ctx = { ...CTX, meta: { ...CTX.meta, kind: 'flight' as const } };

      await service.render([item({ price: 210000 })], ctx, {
        provider: 'openai',
        links: new Map(),
      });

      expect(inserted[0][0]).toMatchObject({ domain: 'flight', price: 210000 });
    });

    /** AI 결과는 필드가 비어 오는 게 흔하다. 빈 칸은 null 이지 행이 사라지지 않는다. */
    it('값이 없어도 칸은 null 로 남는다', async () => {
      const { service, inserted } = build();

      await service.render([item()], CTX, { provider: 'openai' });

      expect(inserted[0][0]).toMatchObject({ price: null, merchant: null, image_url: null });
    });
  });

  // ---------------------------------------------------------- links 를 안 넘긴 경우
  describe('제휴 변환을 다루지 않는 도메인', () => {
    it('목적지는 원본 주소 그대로이고 subid 를 붙이지 않는다', async () => {
      // subid 를 켜둔 설정에서도 붙으면 안 된다 — 지도 주소에 달아봐야 아무도 안 읽는다.
      const { service, inserted } = build({ adpickSubidParam: 'subid' });

      await service.render([item()], CTX, { provider: 'openai' });

      const row = inserted[0][0];
      expect(row.target_url).toBe(MAP_URL);
      expect(row.source_url).toBe(MAP_URL);
      // 변환을 안 타는 도메인이라 칸은 null 이다. **"타는데 실패했다"(도 null)와
      // 구별되는 건 links 를 넘겼는지뿐이고, 그건 경고 여부로 갈린다** (아래 테스트).
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
    const HOTEL_CTX = { ...CTX, meta: { ...CTX.meta, kind: 'hotel' as const } };

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

      await service.render([hotel], HOTEL_CTX, { provider: 'openai', links });

      const row = inserted[0][0];
      expect(row.target_url).toBe('https://link.adpick.co.kr/abcd');
      // 원본은 DB 에만 남는다 — 사용자에게 나가는 건 리다이렉트뿐이다.
      expect(row.source_url).toBe(BOOKING);
      expect(row.affiliate_link_id).toBe('link-1');
    });

    /**
     * ⚠️ 변환 실패는 **행이 사라지는 게 아니라 null 로 남아야** 세어볼 수 있다.
     *    그 노출은 수수료가 0 인데, 행까지 없으면 "수익화 누수" 집계에서 통째로
     *    빠진다 — 찾으려던 것만 안 보이게 된다.
     */
    it('변환 실패는 null 로 남는다 — 행이 사라지지 않는다', async () => {
      const { service, inserted } = build();

      await service.render([hotel], HOTEL_CTX, {
        provider: 'openai',
        links: new Map<string, ResolvedLink>(),
      });

      expect(inserted[0][0]).toHaveProperty('affiliate_link_id', null);
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

    /**
     * 도메인은 제휴를 타는데 **그 줄만 못 타는** 경우 (스카이스캐너 — 애드픽에
     * 광고주가 없다). 이걸 실패로 세면 경고가 매 검색마다 떠서, "수수료가 샌다" 는
     * 신호가 상시 경고가 되고 그때부터 진짜 누수도 안 보인다.
     */
    describe('제휴를 못 타는 줄이 섞여 있을 때', () => {
      const META = 'https://www.skyscanner.co.kr/transport/flights/sel/tyoa/';
      const meta = item({
        label: '스카이스캐너 ICN→NRT',
        sourceUrl: META,
        title: '스카이스캐너에서 보기',
        merchant: 'skyscanner',
        monetizable: false,
      });

      it('변환 실패로 세지 않는다 — 샐 수수료가 애초에 없다', async () => {
        const { service } = build();
        const warn = jest.spyOn(service['logger'], 'warn');

        await service.render([meta], CTX, {
          provider: 'openai',
          links: new Map<string, ResolvedLink>(),
        });

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      it('같은 카드의 다른 줄이 변환에 실패하면 그건 센다', async () => {
        const { service } = build();
        const warn = jest.spyOn(service['logger'], 'warn');

        await service.render([meta, hotel], CTX, {
          provider: 'openai',
          links: new Map<string, ResolvedLink>(),
        });

        // **분모가 2 가 아니라 1 이다.** 못 타는 줄을 분모에 넣으면 실패율이 실제보다
        // 낮게 보여서, 전부 실패한 상황이 "절반만 실패" 로 읽힌다.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('애드픽 변환 실패 1/1건'));
        warn.mockRestore();
      });

      it('원본 주소로 그대로 보내고 subid 도 안 붙인다', async () => {
        const { service, inserted } = build({ adpickSubidParam: 'subid' });

        await service.render([meta], CTX, {
          provider: 'openai',
          links: new Map<string, ResolvedLink>(),
        });

        const row = inserted[0][0];
        expect(row.target_url).toBe(META);
        // ⚠️ 변환 실패도 null 이다. 집계에서 둘을 가르는 건 merchant 칸이다.
        expect(row.affiliate_link_id).toBeNull();
        expect(row.merchant).toBe('skyscanner');
      });
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

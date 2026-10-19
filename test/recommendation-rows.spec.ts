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
 * ⚠️ **0015 에서 제휴 변환이 여기서 빠졌다.** 예전에는 호출부가 줄마다 미리 변환해
 *    `links` 로 넘겼고, 이 파일은 그 Map 을 안 넘긴 경우와 넘겼는데 비어 있는 경우를
 *    구별하는 것이 요점이었다. 이제 변환은 눌린 줄 하나만 `/r/{clickId}` 가 하므로
 *    (그 계약은 [redirect.spec.ts](./redirect.spec.ts) 가 지킨다) 여기서 지킬 것은
 *    **원본 주소가 그대로 남는가** 하나다.
 *
 *    그 Map 이 사라진 이유는 비용이다 — 눌리는 줄은 많아야 하나인데 전부 변환했고,
 *    캐시가 빗나가면 카카오 5초 예산에서 2초를 먹었다. 넘기면 무응답이다.
 *
 * ⚠️ **관광지는 이 서비스를 안 탄다.** 0012 부터 노출 행 대신 `attractions` 의
 *    카운터를 올린다 ([attraction-counters.spec.ts](./attraction-counters.spec.ts)).
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

      await service.render([item({ price: 210000 })], ctx, { provider: 'openai' });

      expect(inserted[0][0]).toMatchObject({ domain: 'flight', price: 210000 });
    });

    /** AI 결과는 필드가 비어 오는 게 흔하다. 빈 칸은 null 이지 행이 사라지지 않는다. */
    it('값이 없어도 칸은 null 로 남는다', async () => {
      const { service, inserted } = build();

      await service.render([item()], CTX, { provider: 'openai' });

      expect(inserted[0][0]).toMatchObject({ price: null, merchant: null, image_url: null });
    });
  });

  // ------------------------------------------------- 변환은 여기서 하지 않는다 (0015)
  describe('제휴 변환은 클릭 시점으로 갔다', () => {
    const BOOKING = 'https://kr.trip.com/hotels/osaka-detail-1/';
    const hotel = item({
      label: '호텔 A',
      sourceUrl: BOOKING,
      title: '호텔 A',
      merchant: 'trip',
    });

    it('목적지는 원본 주소다 — 커미션 링크는 리다이렉트가 만든다', async () => {
      const { service, inserted } = build();

      await service.render([hotel], CTX, { provider: 'openai' });

      const row = inserted[0][0];
      expect(row.target_url).toBe(BOOKING);
      expect(row.source_url).toBe(BOOKING);
    });

    /**
     * ⚠️ **붙일 대상이 아직 없다.** subid 는 커미션 링크에 다는 것인데 노출 시점엔
     *    원본 주소뿐이다. 여기서 달면 원본에 추적 파라미터만 지저분하게 남고,
     *    리다이렉트가 커미션 링크에 다시 달아야 한다.
     */
    it('subid 를 켜두어도 붙이지 않는다', async () => {
      const { service, inserted } = build({ adpickSubidParam: 'subid' });

      await service.render([hotel], CTX, { provider: 'openai' });

      expect(String(inserted[0][0].target_url)).toBe(BOOKING);
    });

    /**
     * ⚠️ **누르지 않은 줄은 영원히 null 이고 그게 맞는 값이다.** 집계에서 "변환
     *    실패" 를 세려면 반드시 `click_count > 0` 을 걸어야 한다 — 안 걸면 노출
     *    전부가 실패로 세어진다 (0015 의 확인 쿼리).
     */
    it('affiliate_link_id 는 비어 있다 — 클릭이 있어야 채워진다', async () => {
      const { service, inserted } = build();

      await service.render([hotel], CTX, { provider: 'openai' });

      expect(inserted[0][0]).toHaveProperty('affiliate_link_id', null);
    });

    it('변환 실패 경고를 남기지 않는다 — 변환을 안 하기 때문이다', async () => {
      const { service } = build();
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.render([hotel], CTX, { provider: 'openai' });

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    /**
     * 도메인은 제휴를 타는데 **그 줄만 못 타는** 경우 (스카이스캐너 — 애드픽에
     * 광고주가 없다). 예전에는 `monetizable` 칸으로 알렸는데, 그 판정을 리다이렉트가
     * `adpickCarries(merchant)` 로 다시 하므로 칸이 사라졌다. **merchant 가 안 남으면
     * 리다이렉트가 그 줄을 변환하려 들고, 애드픽 호출 하나가 매번 헛돈다.**
     */
    it('merchant 를 남긴다 — 리다이렉트가 이 값으로 변환 여부를 가린다', async () => {
      const { service, inserted } = build();
      const meta = item({
        label: '스카이스캐너 ICN→NRT',
        sourceUrl: 'https://www.skyscanner.co.kr/transport/flights/sel/tyoa/',
        title: '스카이스캐너에서 보기',
        merchant: 'skyscanner',
      });

      await service.render([meta], CTX, { provider: 'openai' });

      expect(inserted[0][0].merchant).toBe('skyscanner');
    });
  });

  // ------------------------------------------------------------------ 공통
  it('DB 가 없어도 리다이렉트가 살도록 인메모리에도 남긴다', async () => {
    const { service, inserted, memory } = build();

    await service.render([item({ merchant: 'trip' })], CTX, { provider: 'openai' });

    const clickId = String(inserted[0][0].click_id);
    // ⚠️ merchant 도 같이 남겨야 한다. 빠른 길(인메모리)로 들어온 클릭은 DB 를 안
    //    보므로, 없으면 "이 줄이 애드픽을 타는가" 를 리다이렉트가 못 가린다.
    expect(memory.get(clickId)).toMatchObject({ targetUrl: MAP_URL, merchant: 'trip' });
  });

  it('persist:false 면 통계를 남기지 않는다 (진단 경로)', async () => {
    const { service, inserted } = build();

    const rows = await service.render([item()], { ...CTX, persist: false }, { provider: 'openai' });

    // 카드는 그대로 나오지만 recommendation_items 는 비어 있다.
    expect(rows).toHaveLength(1);
    expect(inserted).toHaveLength(0);
  });
});

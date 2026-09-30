import { RedirectController } from '../src/modules/redirect/redirect.controller';
import { MemoryStoreService } from '../src/modules/database/memory-store.service';

/**
 * 클릭 리다이렉트. **사용자가 302 를 기다리는 유일한 경로다.**
 *
 * 실측(운영 서버 → Supabase)은 따뜻한 연결 ~90ms, **콜드 연결 ~730ms** 다.
 * 목적지를 이미 아는데 그걸 기다릴 이유가 없다 — 특히 배포 직후 첫 클릭들이
 * 콜드 비용을 낸다.
 */

function fakeRes() {
  const sent: { status?: number; redirect?: string; html?: string } = {};
  const res = {
    redirect: (_code: number, url: string) => {
      sent.redirect = url;
    },
    status: (code: number) => {
      sent.status = code;
      return res;
    },
    type: () => res,
    send: (html: string) => {
      sent.html = html;
    },
  };
  return { res, sent };
}

function build(
  dbRow: Record<string, unknown> | null,
  dbDelayMs = 0,
  attractionRow: Record<string, unknown> | null = null,
) {
  const calls: string[] = [];
  const items = {
    registerClick: async (clickId: string) => {
      calls.push(clickId);
      if (dbDelayMs) await new Promise((r) => setTimeout(r, dbDelayMs));
      return dbRow;
    },
  } as never;
  const attractions = {
    registerClick: async (id: number) => {
      calls.push(`a:${id}`);
      return attractionRow;
    },
  } as never;
  const memory = new MemoryStoreService();
  return { calls, memory, controller: new RedirectController(items, memory, attractions) };
}

const ENTRY = {
  recommendationId: 'rec-1',
  itemName: '오사카성',
  sourceUrl: 'https://maps/1',
  targetUrl: 'https://www.google.com/maps/search/?api=1&query=x&query_place_id=ChIJ_1',
  userId: null,
};

describe('클릭 리다이렉트', () => {
  it('목적지를 알고 있으면 DB 를 기다리지 않는다', async () => {
    // DB 가 1초 걸려도 응답은 그 전에 나가야 한다.
    const { controller, memory, calls } = build({ target_url: 'https://느린곳' }, 1000);
    memory.put('c1', ENTRY);
    const { res, sent } = fakeRes();

    const started = Date.now();
    await controller.redirect('c1', res as never);

    expect(sent.redirect).toBe(ENTRY.targetUrl);
    expect(Date.now() - started).toBeLessThan(200);
    // 카운터는 뒤에서 올린다 — 부르긴 부른다.
    expect(calls).toEqual(['c1']);
  });

  it('메모리에 없으면 DB 목적지로 보낸다', async () => {
    const { controller } = build({ target_url: 'https://db/1', item_name: '도톤보리', click_count: 3 });
    const { res, sent } = fakeRes();

    await controller.redirect('c2', res as never);

    expect(sent.redirect).toBe('https://db/1');
  });

  it('둘 다 없으면 만료 안내 — 목적지를 모른 채 보낼 수는 없다', async () => {
    const { controller } = build(null);
    const { res, sent } = fakeRes();

    await controller.redirect('없는키', res as never);

    expect(sent.status).toBe(404);
    expect(sent.html).toContain('만료');
    expect(sent.redirect).toBeUndefined();
  });

  /** 카운터 기록이 실패해도 사용자는 이미 목적지로 갔어야 한다. */
  it('백그라운드 카운트가 터져도 이동은 이미 끝나 있다', async () => {
    const items = {
      registerClick: async () => {
        throw new Error('DB 폭발');
      },
    } as never;
    const memory = new MemoryStoreService();
    memory.put('c3', ENTRY);
    const { res, sent } = fakeRes();

    await new RedirectController(items, memory, {} as never).redirect('c3', res as never);
    await new Promise((r) => setTimeout(r, 10));

    expect(sent.redirect).toBe(ENTRY.targetUrl);
  });
});

/**
 * 관광지는 길이 다르다 — `/a/{id}` 는 **관광지별로 고정된 주소**다.
 *
 * 노출마다 키를 발급하지 않으므로 단톡방에 오래 남은 카드의 링크도 안 죽고,
 * 목적지는 클릭 시점의 이름으로 다시 만들어진다 (0012).
 */
describe('관광지 클릭 리다이렉트', () => {
  it('클릭 시점의 이름으로 지도 주소를 만든다', async () => {
    const { controller, calls } = build(null, 0, {
      attraction_name: '오사카성',
      city_name: '오사카',
      clicks: 12,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(7, res as never);

    expect(calls).toEqual(['a:7']);
    expect(sent.redirect).toBe(
      'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('오사카성 오사카'),
    );
  });

  /**
   * 세부 지역은 부모 도시가 붙는다 ("도톤보리 오사카"). 노출 때 만든 링크와 같은
   * 주소가 나와야 하므로 RPC 가 `searchName()` 과 같은 규칙으로 맞춰서 준다.
   */
  it('세부 지역이면 부모 도시가 붙은 채로 온다', async () => {
    const { controller } = build(null, 0, {
      attraction_name: '글리코 간판',
      city_name: '도톤보리 오사카',
      clicks: 1,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(9, res as never);

    expect(sent.redirect).toContain(encodeURIComponent('글리코 간판 도톤보리 오사카'));
  });

  it('지워진 관광지면 안내를 띄운다 — 만료가 아니라 없어진 것이다', async () => {
    const { controller } = build(null, 0, null);
    const { res, sent } = fakeRes();

    await controller.attraction(404, res as never);

    expect(sent.status).toBe(404);
    expect(sent.html).toContain('없어진');
    expect(sent.redirect).toBeUndefined();
  });
});

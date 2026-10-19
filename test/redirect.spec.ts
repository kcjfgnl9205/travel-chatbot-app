import { RedirectController } from '../src/modules/redirect/redirect.controller';
import { MemoryStoreService } from '../src/modules/database/memory-store.service';
import { ResolvedLink } from '../src/modules/affiliate/affiliate.service';
import { AppConfig, loadConfig } from '../src/config/app.config';

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

/** 애드픽 대역. 기본값은 "변환할 줄이 없다" — 대부분의 테스트가 변환과 무관하다. */
function fakeAffiliate(
  over: { link?: ResolvedLink | null; delayMs?: number; throws?: boolean } = {},
) {
  const seen: { sourceUrl: string; merchant: string | null }[] = [];
  const service = {
    resolveForClick: async (sourceUrl: string, merchant: string | null) => {
      seen.push({ sourceUrl, merchant });
      if (over.delayMs) await new Promise((r) => setTimeout(r, over.delayMs));
      if (over.throws) throw new Error('애드픽 폭발');
      return over.link ?? null;
    },
  };
  return { seen, service };
}

function build(
  dbRow: Record<string, unknown> | null,
  dbDelayMs = 0,
  attractionRow: Record<string, unknown> | null = null,
  affiliate = fakeAffiliate(),
  config: AppConfig = loadConfig(),
) {
  const calls: string[] = [];
  const attached: { clickId: string; linkId: string }[] = [];
  const items = {
    registerClick: async (clickId: string) => {
      calls.push(clickId);
      if (dbDelayMs) await new Promise((r) => setTimeout(r, dbDelayMs));
      return dbRow;
    },
    attachAffiliateLink: async (clickId: string, linkId: string) => {
      attached.push({ clickId, linkId });
    },
  } as never;
  const attractions = {
    registerClick: async (id: number) => {
      calls.push(`a:${id}`);
      return attractionRow;
    },
  } as never;
  const memory = new MemoryStoreService();
  return {
    calls,
    attached,
    memory,
    seen: affiliate.seen,
    controller: new RedirectController(
      config,
      items,
      memory,
      attractions,
      affiliate.service as never,
    ),
  };
}

const ENTRY = {
  recommendationId: 'rec-1',
  itemName: '오사카성',
  sourceUrl: 'https://maps/1',
  targetUrl: 'https://www.google.com/maps/search/?api=1&query=x&query_place_id=ChIJ_1',
  // 애드픽이 취급하지 않는 판매처 → 변환을 시도하지 않는다. 변환과 무관한
  // 테스트들이 302 만 보게 하려는 기본값이다.
  merchant: 'skyscanner',
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

    await new RedirectController(
      loadConfig(),
      items,
      memory,
      {} as never,
      fakeAffiliate().service as never,
    ).redirect('c3', res as never);
    await new Promise((r) => setTimeout(r, 10));

    expect(sent.redirect).toBe(ENTRY.targetUrl);
  });
});

/**
 * **커미션 링크를 여기서 만든다** (0015).
 *
 * 카드를 만들 때 줄마다 미리 변환하던 것을 옮겼다 — 눌리는 줄은 많아야 하나인데
 * 전부 변환했고, 캐시가 빗나가면 카카오 5초 예산에서 2초를 먹어 **말풍선이 통째로
 * 안 나갔다.** 그 2초가 여기로 왔으므로, 여기서 지킬 것은 하나다:
 * **무슨 일이 있어도 사용자는 항목에 도착한다.**
 */
describe('클릭 시점 제휴 변환', () => {
  const BOOKING = 'https://kr.trip.com/hotels/osaka-detail-1/';
  const LINK: ResolvedLink = {
    sourceUrl: BOOKING,
    affiliateUrl: 'https://link.adpick.co.kr/abcd',
    affiliateLinkId: 'link-1',
    status: 'ok',
    fromCache: false,
  };
  const entry = (over = {}) => ({
    recommendationId: 'rec-1',
    itemName: '호텔 A',
    sourceUrl: BOOKING,
    targetUrl: BOOKING,
    merchant: 'trip',
    userId: null,
    ...over,
  });

  it('원본 주소를 커미션 링크로 바꿔서 보낸다', async () => {
    const { controller, memory, seen } = build(null, 0, null, fakeAffiliate({ link: LINK }));
    memory.put('c1', entry());
    const { res, sent } = fakeRes();

    await controller.redirect('c1', res as never);

    expect(seen).toEqual([{ sourceUrl: BOOKING, merchant: 'trip' }]);
    expect(sent.redirect).toBe(LINK.affiliateUrl);
  });

  it('DB 에서 온 줄도 같다 — 재료는 register_click 이 같이 준다', async () => {
    const { controller, seen } = build(
      { target_url: BOOKING, source_url: BOOKING, merchant: 'trip', item_name: '호텔 A' },
      0,
      null,
      fakeAffiliate({ link: LINK }),
    );
    const { res, sent } = fakeRes();

    await controller.redirect('c2', res as never);

    expect(seen).toHaveLength(1);
    expect(sent.redirect).toBe(LINK.affiliateUrl);
  });

  it('subid 를 설정했으면 커미션 링크에 붙는다 — clickId 가 그 값이다', async () => {
    const { controller, memory } = build(null, 0, null, fakeAffiliate({ link: LINK }), {
      ...loadConfig(),
      adpickSubidParam: 'subid',
    });
    memory.put('c3', entry());
    const { res, sent } = fakeRes();

    await controller.redirect('c3', res as never);

    expect(sent.redirect).toContain('subid=c3');
  });

  it('성공하면 그 줄에 affiliate_link_id 를 달아둔다', async () => {
    const { controller, memory, attached } = build(null, 0, null, fakeAffiliate({ link: LINK }));
    memory.put('c4', entry());
    const { res } = fakeRes();

    await controller.redirect('c4', res as never);
    await new Promise((r) => setTimeout(r, 10));

    expect(attached).toEqual([{ clickId: 'c4', linkId: 'link-1' }]);
  });

  // ------------------------------------------------- 무슨 일이 있어도 도착한다
  it('변환이 비면 원본 주소로 보낸다 — 수수료는 잃어도 사용자는 호텔을 본다', async () => {
    const { controller, memory } = build(null, 0, null, fakeAffiliate({ link: null }));
    memory.put('c5', entry());
    const { res, sent } = fakeRes();

    await controller.redirect('c5', res as never);

    expect(sent.redirect).toBe(BOOKING);
  });

  it('변환이 터져도 원본 주소로 보낸다', async () => {
    const { controller, memory } = build(null, 0, null, fakeAffiliate({ throws: true }));
    memory.put('c6', entry());
    const { res, sent } = fakeRes();

    await controller.redirect('c6', res as never);

    expect(sent.redirect).toBe(BOOKING);
  });

  /**
   * ⚠️ 애드픽에 광고주가 없는 플랫폼(스카이스캐너)은 **부르지도 않는다.** 부르면
   *    클릭마다 실패 한 건이 쌓이고, 그 경고가 상시로 떠서 진짜 누수를 가린다.
   */
  it('애드픽을 안 타는 판매처는 변환을 시도조차 하지 않는다', async () => {
    const { controller, memory, seen } = build(null, 0, null, fakeAffiliate({ link: LINK }));
    memory.put('c7', entry({ merchant: 'skyscanner' }));
    const { res, sent } = fakeRes();

    await controller.redirect('c7', res as never);

    expect(seen).toEqual([]);
    expect(sent.redirect).toBe(BOOKING);
  });

  /**
   * ⚠️ **마이그레이션 0015 전이면 source_url 이 안 온다.** 그때는 저장된 목적지로
   *    그냥 보낸다 — 코드를 먼저 올리든 SQL 을 먼저 돌리든 링크가 죽으면 안 된다.
   */
  it('옛 register_click() 이면 변환을 건너뛰고 저장된 목적지로 보낸다', async () => {
    const { controller, seen } = build(
      { target_url: 'https://link.adpick.co.kr/old', item_name: '호텔 A' },
      0,
      null,
      fakeAffiliate({ link: LINK }),
    );
    const { res, sent } = fakeRes();

    await controller.redirect('c8', res as never);

    expect(seen).toEqual([]);
    expect(sent.redirect).toBe('https://link.adpick.co.kr/old');
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

  /**
   * 국내는 카카오맵으로 보낸다. 상호·도로명이 정확하고 한국 사용자가 길찾기를
   * 거기서 하기 때문이다. 판정은 도시 사전의 `country === 'KR'` 하나다.
   */
  it('국내 도시면 카카오맵으로 보낸다', async () => {
    const { controller } = build(null, 0, {
      attraction_name: '경복궁',
      city_name: '서울',
      clicks: 3,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(11, res as never);

    expect(sent.redirect).toBe(
      'https://map.kakao.com/link/search/' + encodeURIComponent('경복궁 서울'),
    );
  });

  /**
   * ⚠️ **카카오맵은 해외 데이터가 거의 없다.** 오사카성을 거기로 보내면 빈 결과가
   *    뜨므로, 사전에 `country` 가 없는 도시는 전부 구글맵으로 간다 — 모를 때
   *    틀려도 손해가 작은 쪽이다.
   */
  it('사전에 country 가 없는 도시는 구글맵으로 간다', async () => {
    const { controller } = build(null, 0, {
      attraction_name: '센토사',
      city_name: '싱가포르',
      clicks: 1,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(12, res as never);

    expect(sent.redirect).toContain('google.com/maps');
  });

  /**
   * ⚠️ **사전에 없는 국내 도시가 이 분기의 존재 이유다.**
   *
   * 사전 경로는 country_code 를 null 로 넣고 모델 경로는 채운다. 그래서 춘천처럼
   * 나중에 등록된 도시는 사전에 없고 DB 에만 'KR' 이 있다 — 사전만 보면 국내인데도
   * 구글맵으로 간다.
   */
  it('사전에 없어도 DB 가 KR 이면 카카오맵으로 보낸다', async () => {
    const { controller } = build(null, 0, {
      attraction_name: '남이섬',
      city_name: '춘천',
      country_code: 'KR',
      clicks: 1,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(13, res as never);

    expect(sent.redirect).toBe(
      'https://map.kakao.com/link/search/' + encodeURIComponent('남이섬 춘천'),
    );
  });

  /**
   * 세부 지역은 city_name 이 "해운대 부산" 으로 붙어 와서 사전 전체 일치가 깨진다.
   * RPC 가 부모의 country_code 를 폴백으로 주므로(0014) 그래도 국내로 잡힌다.
   */
  it('국내 세부 지역은 부모의 country_code 가 구해준다', async () => {
    const { controller } = build(null, 0, {
      attraction_name: '동백섬',
      city_name: '해운대 부산',
      country_code: 'KR',
      clicks: 1,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(14, res as never);

    expect(sent.redirect).toContain('map.kakao.com');
  });

  /**
   * ⚠️ 반대 방향도 지켜야 한다. 해외 세부 지역은 country_code 가 'JP' 라서
   *    카카오맵으로 가면 안 된다 — 빈 결과가 뜬다.
   */
  it('해외 세부 지역은 구글맵이다', async () => {
    const { controller } = build(null, 0, {
      attraction_name: '글리코 간판',
      city_name: '도톤보리 오사카',
      country_code: 'JP',
      clicks: 1,
    });
    const { res, sent } = fakeRes();

    await controller.attraction(15, res as never);

    expect(sent.redirect).toContain('google.com/maps');
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

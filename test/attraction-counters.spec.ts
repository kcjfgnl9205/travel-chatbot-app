import { loadConfig } from '../src/config/app.config';
import { AttractionService } from '../src/modules/attraction/attraction.service';
import { Attraction } from '../src/modules/attraction/attraction.types';
import { StaticRow } from '../src/modules/recommendation/rows.service';
import { RenderContext } from '../src/modules/search/search.types';

/**
 * **관광지는 노출마다 행을 쌓지 않는다** (0012).
 *
 * 호텔·항공권은 매 검색마다 목록을 새로 받아오고 캐시는 갱신되면 덮어써지므로,
 * "그때 사용자가 본 값" 을 `recommendation_items` 에 복사해두지 않으면 영영 복원이
 * 안 된다. 관광지 목록은 우리 `attractions` 테이블에 영구히 있어서 복사할 것이 없다.
 *
 * 그래서 여러 사람이 같은 도시를 계속 물어도 **행이 안 자란다.** 이 파일이 지키는
 * 것이 그 성질이다 — 렌더러의 `render`(행을 쌓는 길)를 부르면 실패한다.
 */

const CTX = (persist?: boolean): RenderContext => ({
  meta: { kind: 'attraction', placeName: '후쿠오카', placeSlug: 'fukuoka' },
  userId: null,
  messageId: null,
  started: Date.now(),
  cacheHit: false,
  ...(persist === undefined ? {} : { persist }),
});

const OSAKA_CASTLE: Attraction = {
  id: 7,
  name: '오사카성',
  citySlug: 'osaka',
  mapUrl: 'https://maps/1',
  area: '주오구',
  imageUrl: 'https://img/1.jpg',
};

/** 이 테스트는 rows() 만 본다 — 백필은 search() 쪽 일이라 여기선 안 탄다. */
const noBackfill = { enabled: false, fill: async () => ({ inserted: 0, proposed: 0 }) } as never;

function build() {
  const counted: StaticRow[] = [];
  const impressions: number[][] = [];

  const renderer = {
    renderCounted: async (rows: StaticRow[]) => {
      counted.push(...rows);
      return rows.map(() => ({}));
    },
    // 관광지가 이 길로 새면 노출 행이 다시 쌓이기 시작한다. 조용히 넘어가면 안 된다.
    render: async () => {
      throw new Error('관광지는 render() 를 타면 안 된다 — 노출 행이 쌓인다');
    },
  } as never;

  const attractions = {
    registerImpressions: async (ids: number[]) => {
      impressions.push(ids);
    },
  } as never;

  const service = new AttractionService(
    loadConfig(),
    { name: 'db' } as never,
    renderer,
    noBackfill,
    attractions,
  );
  return { counted, impressions, service };
}

describe('관광지 노출 카운터', () => {
  it('노출 행 대신 카운터를 올린다', async () => {
    const { service, impressions } = build();

    await service.rows([OSAKA_CASTLE], CTX());

    // 스무 곳이 나가도 UPDATE 한 문장이다 — 배열로 한 번에 보낸다.
    expect(impressions).toEqual([[7]]);
  });

  it('줄 링크가 관광지 id 로 고정된다 — 노출마다 발급하는 키가 아니다', async () => {
    const { service, counted } = build();

    await service.rows([OSAKA_CASTLE], CTX());

    expect(counted[0].linkUrl).toMatch(/\/a\/7$/);
    // 지도 주소를 카드에 직접 넣지 않는다. 그러면 클릭 신호가 아예 안 온다.
    expect(counted[0].linkUrl).not.toContain('google.com');
  });

  it('같은 목록을 두 번 내보내도 같은 링크다', async () => {
    const { service, counted } = build();

    await service.rows([OSAKA_CASTLE], CTX());
    await service.rows([OSAKA_CASTLE], CTX());

    expect(counted[0].linkUrl).toBe(counted[1].linkUrl);
  });

  /**
   * 진단 경로(persist:false)가 분모를 흐리면 안 된다. 아무도 안 본 노출이 섞이면
   * 클릭률이 실제보다 낮게 보이고, 그 값으로 rank 를 조정하게 된다.
   */
  it('진단 경로는 카운터를 안 올린다', async () => {
    const { service, impressions } = build();

    await service.rows([OSAKA_CASTLE], CTX(false));

    expect(impressions).toEqual([]);
  });
});

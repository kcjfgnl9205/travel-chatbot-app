import { Flight, FlightProvider, FlightQuery } from '../src/modules/flight/flight.types';
import { FlightService } from '../src/modules/flight/flight.service';
import { SearchContext } from '../src/modules/search/search.types';
import { loadConfig } from '../src/config/app.config';

/**
 * 진단용 계측(`POST /api/v1/debug/search` 의 `trace`).
 *
 * ⚠️ 한 번은 원인 규명이 **서버 로그 없이는 불가능**했다 — 모델이 웹 검색을 건너뛴
 *    사실이 로그에만 있었고, 응답만 보면 그냥 빈손이었다. 여기서 지키는 건
 *    **"왜 빈손인가" 를 응답만 보고 가를 수 있는가** 다. 원인이 셋인데 고치는 곳이
 *    전부 다르기 때문이다 —
 *
 *      searchCalls=0  모델이 웹 검색을 건너뛴 것        → 프롬프트/tool_choice
 *      candidates=0   1차가 아무것도 못 모은 것          → 검색 프롬프트
 *      picks>0 kept=0 정규화가 전부 버린 것              → 허용 호스트/필수 필드
 */

const PLACE = { id: 1, slug: 'osaka', canonicalName: '오사카', iata: 'KIX' } as never;
const CTX: SearchContext = {
  kind: 'flight',
  place: PLACE,
  parent: null,
  from: null,
  tripType: 'rt',
  limit: 10,
};

function flight(over: Partial<Flight> = {}): Flight {
  return {
    airline: '대한항공',
    originCode: 'ICN',
    destCode: 'KIX',
    tripType: 'round',
    priceFrom: 150000,
    sourceUrl: 'https://kr.trip.com/flights/seoul-to-osaka/',
    merchant: 'trip',
    ...over,
  };
}

/** 계측을 돌려주는 provider — 진짜 AI provider 가 이 모양이다. */
class TracedProvider implements FlightProvider {
  readonly name = 'traced';
  constructor(
    private readonly flights: Flight[],
    private readonly trace: object,
  ) {}
  async search(): Promise<Flight[]> {
    return this.flights;
  }
  async searchTraced(_query: FlightQuery) {
    return { flights: this.flights, trace: this.trace, candidates: '[{"airline":"대한항공"}]' };
  }
}

/** 계측이 없는 provider — 테스트용·DB provider 가 이 모양이다. */
class PlainProvider implements FlightProvider {
  readonly name = 'plain';
  constructor(private readonly flights: Flight[]) {}
  async search(): Promise<Flight[]> {
    return this.flights;
  }
}

function build(provider: FlightProvider) {
  const affiliate = { resolve: async () => new Map() } as never;
  const renderer = { render: async () => [] } as never;
  return new FlightService(loadConfig(), provider, affiliate, renderer);
}

describe('진단 계측', () => {
  const TRACE = { searchMs: 9000, rankMs: 400, searchCalls: 2, candidates: 20, picks: 10 };

  it('provider 계측과 1차 원문을 그대로 실어 보낸다', async () => {
    const service = build(new TracedProvider([flight()], TRACE));

    const { trace } = await service.searchTraced(CTX);

    expect(trace.provider).toEqual(TRACE);
    expect(trace.candidates).toContain('대한항공');
  });

  /**
   * ⚠️ **이게 이 파일의 이유다.** picks=10 인데 카드가 비면 provider 가 아니라
   *    정규화를 봐야 한다. 그 차이가 응답에 안 보이면 1차에서 원인을 찾게 된다.
   */
  it('picks 는 있는데 kept 가 0 이면 정규화가 버린 것이다', async () => {
    // 2차는 10개를 골랐는데 전부 허용 밖 호스트라 provider 가 버렸다 — 실제로
    // 운영에서 스무 곳 중 열아홉이 이렇게 떨어진 적이 있다.
    const service = build(new TracedProvider([], TRACE));

    const { items, trace } = await service.searchTraced(CTX);

    expect(items).toHaveLength(0);
    expect(trace.kept).toBe(0);
    // 2차는 제 몫을 했다(picks=10). 둘이 갈리는 지점이 곧 고칠 자리다 —
    // 여기가 같았다면 1차 프롬프트를, 다르면 허용 호스트 목록을 본다.
    expect((trace.provider as typeof TRACE).picks).toBe(10);
  });

  it('kept 는 카드까지 가는 줄 수다 — 편이 아니라 플랫폼 수다', async () => {
    const service = build(
      new TracedProvider(
        [
          flight({ flightNo: 'KE723' }),
          flight({ flightNo: 'KE725', priceFrom: 180000 }),
          flight({
            flightNo: 'MM12',
            merchant: 'myrealtrip',
            sourceUrl: 'https://www.myrealtrip.com/flights/ICN-KIX',
          }),
        ],
        TRACE,
      ),
    );

    const { items, trace } = await service.searchTraced(CTX);

    // 편 3개가 플랫폼 2줄로 접힌다. 그 접힘까지 지나야 kept 다.
    expect(items).toHaveLength(2);
    expect(trace.kept).toBe(2);
  });

  /** 단계가 없는 provider 가 빈 숫자를 지어내면 그게 진짜처럼 보인다. */
  it('계측이 없는 provider 는 null 로 남긴다 — 0 으로 채우지 않는다', async () => {
    const service = build(new PlainProvider([flight()]));

    const { items, trace } = await service.searchTraced(CTX);

    expect(trace.provider).toBeNull();
    expect(trace.candidates).toBeNull();
    expect(trace.kept).toBe(items.length);
  });
});

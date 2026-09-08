import { Flight, FlightProvider, FlightQuery } from '../src/modules/flight/flight.types';

/**
 * 테스트용 항공권 provider.
 *
 * 진짜 OpenAiFlightProvider 를 그대로 두면 테스트가 실제 API 를 때리고 요금이 나간다.
 * FLIGHT_PROVIDER 토큰을 이걸로 덮어써서 검색 결과를 우리가 정한다.
 */
export class FakeFlightProvider implements FlightProvider {
  readonly name = 'fake';

  /** 어떤 쿼리로 몇 번 불렸는지. 캐시·중복 호출 방지 검증에 쓴다. */
  readonly calls: FlightQuery[] = [];
  /** AI 검색이 느린 상황을 흉내 낼 때. */
  delayMs = 0;
  /** 특정 테스트에서 결과를 갈아끼울 때. */
  reply: (query: FlightQuery) => Flight[] = defaultFlights;

  async search(query: FlightQuery): Promise<Flight[]> {
    this.calls.push(query);
    if (this.delayMs) await sleep(this.delayMs);
    return this.reply(query);
  }

  reset(): void {
    this.calls.length = 0;
    this.delayMs = 0;
    this.reply = defaultFlights;
  }
}

/**
 * 느린 검색 흉내.
 *
 * unref() 하지 않으면 테스트가 끝나도 이 타이머가 워커를 붙잡아
 * "worker process has failed to exit gracefully" 가 뜬다.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

const AIRLINES: [string, string][] = [
  ['대한항공', 'KE'],
  ['아시아나항공', 'OZ'],
  ['피치항공', 'MM'],
  ['제주항공', '7C'],
  ['진에어', 'LJ'],
  ['에어부산', 'BX'],
];

/** 캐러셀 제한을 넘겨서 자르기까지 검증되도록 6편을 준다. */
export function defaultFlights(query: FlightQuery): Flight[] {
  return AIRLINES.map(([airline, code], i) => ({
    airline,
    flightNo: `${code}${700 + i}`,
    originCode: query.originCode ?? 'ICN',
    originName: query.originName,
    destCode: query.destCode ?? 'KIX',
    destName: query.destName,
    departDate: query.departDate,
    departTime: `0${8 + i}:20`.slice(-5),
    arriveTime: `${10 + i}:00`,
    returnDate: query.returnDate,
    returnDepartTime: query.tripType === 'round' ? '12:30' : null,
    returnArriveTime: query.tripType === 'round' ? '14:20' : null,
    durationMinutes: 100 + i * 10,
    stops: i % 2,
    via: i % 2 ? '홍콩' : null,
    tripType: query.tripType,
    cabin: query.cabin,
    priceFrom: 148000 + i * 20000,
    currency: 'KRW',
    sourceUrl: `https://kr.trip.com/flights/${query.destSlug}-${i + 1}`,
    merchant: 'trip',
    source: 'ai',
    tags: ['직항', '오전출발'],
  }));
}

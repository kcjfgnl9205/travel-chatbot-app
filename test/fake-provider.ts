import { Hotel, HotelProvider, HotelQuery } from '../src/modules/hotel/hotel.types';

/**
 * 테스트용 provider.
 *
 * 진짜 OpenAiHotelProvider 를 그대로 두면 테스트가 실제 API 를 때리고 요금이 나간다.
 * HOTEL_PROVIDER 토큰을 이걸로 덮어써서 검색 결과를 우리가 정한다.
 */
export class FakeHotelProvider implements HotelProvider {
  readonly name = 'fake';

  /** 어떤 쿼리로 몇 번 불렸는지. 캐시·중복 호출 방지 검증에 쓴다. */
  readonly calls: HotelQuery[] = [];
  /** AI 검색이 느린 상황을 흉내 낼 때. */
  delayMs = 0;
  /** 특정 테스트에서 결과를 갈아끼울 때. */
  reply: (query: HotelQuery) => Hotel[] = defaultHotels;

  async search(query: HotelQuery): Promise<Hotel[]> {
    this.calls.push(query);
    if (this.delayMs) await sleep(this.delayMs);
    return this.reply(query);
  }

  reset(): void {
    this.calls.length = 0;
    this.delayMs = 0;
    this.reply = defaultHotels;
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

/** 페이지 넘김(5줄씩)까지 검증되도록 12곳을 준다. */
export function defaultHotels(query: HotelQuery): Hotel[] {
  return Array.from({ length: 12 }, (_, i) => ({
    name: `${query.cityName} 테스트 호텔 ${i + 1}`,
    citySlug: query.citySlug,
    sourceUrl: `https://example.com/agoda/hotel/${query.citySlug}-${i + 1}`,
    merchant: 'agoda',
    source: 'ai',
    address: `${query.cityName} 중심가`,
    starRating: 4,
    reviewScore: Math.round((9 - i * 0.1) * 10) / 10,
    priceFrom: 120000 + i * 10000,
    currency: 'KRW',
    thumbnailUrl: `https://example.com/img/${i + 1}.jpg`,
    description: '테스트용 호텔',
    tags: ['중심가', '가성비'],
  }));
}

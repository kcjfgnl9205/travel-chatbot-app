import { loadConfig } from '../src/config/app.config';
import { isHotelDetailUrl } from '../src/modules/hotel/search-url';
import { OpenAiHotelProvider } from '../src/modules/hotel/providers/openai.provider';
import { OpenAiService } from '../src/modules/openai/openai.service';

/**
 * **호텔 줄은 그 호텔의 상세 페이지로 가야 한다.**
 *
 * 모델이 도시 목록 페이지를 호텔마다 붙여 왔고, 사용자는 호텔을 눌렀는데 다낭 호텔
 * 목록(검색창)에 떨어졌다 (2026-11-09). 아래 목록 주소 둘은 그때 실제로 열린 것이다
 * (제휴 파라미터는 덜어냈다).
 */
describe('isHotelDetailUrl', () => {
  it.each([
    'https://kr.trip.com/hotels/da-nang-hotels-list-1356/?locale=ko-KR&curr=KRW',
    'https://www.klook.com/ko/destination/c74-da-nang/3-hotel/',
    'https://kr.trip.com/hotels/osaka-list',
    // ⚠️ 번호 뒤를 열어줬어도 **목록 페이지는 여전히 안 들어온다** — 판정의 핵심은
    //    `-detail-{번호}` 조각이고, 목록 주소에는 그게 없다.
    'https://kr.trip.com/hotels/kagoshima-hotels-list-1356/best-hotels',
    'https://kr.hotels.com/de1234/da-nang-vietnam/',
    'https://www.myrealtrip.com/accommodations?keyword=다낭',
    'not a url',
  ])('목록·검색 페이지는 아니다: %s', (url) => {
    expect(isHotelDetailUrl(url)).toBe(false);
  });

  it.each([
    'https://kr.trip.com/hotels/detail/?cityId=248&hotelId=49507812',
    'https://kr.trip.com/hotels/osaka-hotel-detail-688242/',
    // ⚠️ **번호 뒤에 이름 한 토막이 붙어도 상세다.** 예전에는 번호에서 끝나는 주소만
    //    받아서 이런 줄이 목록 페이지 취급으로 버려졌고, 그 도시는 카드가 통째로 비었다.
    'https://kr.trip.com/hotels/kagoshima-hotel-detail-688242/shiroyama-hotel',
    'https://kr.trip.com/hotels/kagoshima-hotel-detail-688242/shiroyama-hotel/?locale=ko-KR',
    'https://kr.trip.com/hotels/Kagoshima-hotel-detail-688242/',
    'https://kr.hotels.com/ho1948759872/hotel-intergate-osaka-umeda-osaka-ilbon/',
    'https://www.klook.com/ko/hotels/detail/1134329-prince-smart-inn-osaka-yodoyabashi/',
    'https://accommodation.myrealtrip.com/union/products/5007313',
    'https://www.myrealtrip.com/offers/12345',
  ])('호텔 한 곳의 상세 페이지다: %s', (url) => {
    expect(isHotelDetailUrl(url)).toBe(true);
  });
});

describe('provider 가 목록 페이지 줄을 버린다', () => {
  const DETAIL = 'https://kr.trip.com/hotels/detail/?cityId=1356&hotelId=1';
  const LISTING = 'https://kr.trip.com/hotels/da-nang-hotels-list-1356/';

  /** 2차에 넘어간 후보 목록. 목록 페이지가 빠져 있어야 한다. */
  let rankInput = '';
  const fakeOpenAi = {
    enabled: true,
    webSearchToolSpec: { type: 'web_search' },
    respond: async (req: any) => {
      if (req.format?.name === 'hotel_candidates') {
        return {
          text: JSON.stringify({
            candidates: [
              { name: '상세 호텔', url: DETAIL, price_from: null, review_score: 9, area: '미케', note: null },
              { name: '목록 호텔', url: LISTING, price_from: null, review_score: 8, area: '한강', note: null },
            ],
          }),
          searchCalls: 1,
          status: 'completed',
          ms: 1,
        };
      }
      rankInput = JSON.stringify(req);
      return { text: JSON.stringify({ picks: [0, 1] }), searchCalls: 0, status: 'completed', ms: 1 };
    },
  } as unknown as OpenAiService;

  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, headers: new Headers(), body: null }) as unknown as Response);
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('상세 페이지 줄만 남기고, 목록 페이지는 2차에도 넘기지 않는다', async () => {
    const { hotels } = await new OpenAiHotelProvider(loadConfig(), fakeOpenAi).searchTraced({
      citySlug: 'da-nang',
      cityName: '다낭',
      guests: null,
      limit: 5,
    });

    expect(hotels.map((h) => h.name)).toEqual(['상세 호텔']);
    expect(rankInput).not.toContain('목록 호텔');
  });
});

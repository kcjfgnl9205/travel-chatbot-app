import { loadConfig } from '../src/config/app.config';
import { Hotel, listDescription } from '../src/modules/hotel/hotel.types';
import { OpenAiHotelProvider, SITE_BRANCHES } from '../src/modules/hotel/providers/openai.provider';
import {
  isGrounded,
  nameKey,
  nameMatchesTitle,
  pageTitleOf,
  sourceKeys,
  urlKey,
} from '../src/modules/hotel/verify';
import { OpenAiService, searchSourcesOf } from '../src/modules/openai/openai.service';

/**
 * **실제 검색 결과에서 확인된 호텔만 카드에 간다.**
 *
 * 모델이 JSON 에 적은 주소는 타이핑한 값이다. 검색 도구가 돌려준 출처와 대조하고,
 * 상세 페이지 제목에 그 호텔 이름이 있는지 보고, 사이트가 달라도 같은 호텔이면 하나만 남긴다.
 */
describe('검색 도구가 돌려준 출처', () => {
  it('검색 결과 · 연 페이지 · 본문 인용을 모두 모은다', () => {
    const body = {
      output: [
        {
          type: 'web_search_call',
          action: {
            type: 'search',
            sources: [{ type: 'url', url: 'https://www.trip.com/hotels/detail/?hotelId=1' }],
          },
        },
        { type: 'web_search_call', action: { type: 'open_page', url: 'https://kr.hotels.com/ho2/' } },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '{}',
              annotations: [{ type: 'url_citation', url: 'https://kr.hotels.com/ho2/' }],
            },
          ],
        },
        { type: 'web_search_call', action: { type: 'search' } }, // 출처 없는 모양도 견딘다
      ],
    };
    expect(searchSourcesOf(body)).toEqual([
      'https://www.trip.com/hotels/detail/?hotelId=1',
      'https://kr.hotels.com/ho2/',
    ]);
  });

  it('모르는 모양이면 빈 목록이다 (던지지 않는다)', () => {
    expect(searchSourcesOf(null)).toEqual([]);
    expect(searchSourcesOf({ output: 'x' })).toEqual([]);
  });
});

describe('주소 대조', () => {
  it.each([
    ['https://kr.trip.com/hotels/detail/?hotelId=1&locale=ko-KR', 'https://www.trip.com/hotels/detail?hotelId=1'],
    ['https://www.klook.com/ko/hotels/detail/11-a/', 'https://www.klook.com/en-US/hotels/detail/11-a'],
    ['https://kr.hotels.com/ho123/abc/', 'https://www.hotels.com/ho123/abc'],
  ])('표기만 다른 같은 페이지: %s', (model, source) => {
    expect(urlKey(model)).toBe(urlKey(source));
  });

  it('트립닷컴은 hotelId 가 다르면 다른 페이지다', () => {
    const keys = sourceKeys(['https://www.trip.com/hotels/detail/?hotelId=1']);
    expect(isGrounded('https://kr.trip.com/hotels/detail/?hotelId=1', keys)).toBe(true);
    expect(isGrounded('https://kr.trip.com/hotels/detail/?hotelId=2', keys)).toBe(false);
  });
});

describe('페이지 제목과 호텔 이름', () => {
  it('한·영 병기 이름은 어느 쪽이든 하나만 겹치면 같은 호텔이다', () => {
    const name = '호텔 그란비아 오사카 (Hotel Granvia Osaka)';
    expect(nameMatchesTitle(name, 'Hotel Granvia Osaka - 호텔스닷컴', ['오사카', 'osaka'])).toBe(true);
    expect(nameMatchesTitle(name, '호텔그란비아오사카 예약 | 트립닷컴', ['오사카', 'osaka'])).toBe(true);
  });

  it('다른 호텔이나 도시 목록 페이지면 아니다', () => {
    const name = '호텔 그란비아 오사카 (Hotel Granvia Osaka)';
    expect(nameMatchesTitle(name, 'Cross Hotel Osaka', ['오사카', 'osaka'])).toBe(false);
    expect(nameMatchesTitle(name, '오사카 호텔 추천 및 예약', ['오사카', 'osaka'])).toBe(false);
  });

  it('비교할 단어가 없으면 버리지 않는다', () => {
    expect(nameMatchesTitle('오사카 호텔', '무엇이든', ['오사카', 'osaka'])).toBe(true);
  });

  it('og:title 을 먼저, 없으면 <title> 을 읽는다', () => {
    expect(pageTitleOf('<meta property="og:title" content="A &amp; B"><title>X</title>')).toBe('A & B');
    expect(pageTitleOf('<title> 그란비아 </title>')).toBe('그란비아');
    expect(pageTitleOf('<p>no title</p>')).toBeNull();
  });

  it('사이트가 달라도 영문 이름이 같으면 같은 호텔이다', () => {
    expect(nameKey('호텔 그란비아 오사카 (Hotel Granvia Osaka)')).toBe(
      nameKey('호텔 그랑비아 오사카 (Hotel Granvia Osaka)'),
    );
  });
});

describe('카드 줄 — 출처와 리뷰 수', () => {
  const hotel = (over: Partial<Hotel>): Hotel => ({ name: 'A', citySlug: 'x', sourceUrl: '', ...over });

  it('출처 사이트를 맨 뒤에 적는다', () => {
    expect(listDescription(hotel({ reviewScore: 9, tags: ['우메다'], merchant: 'trip' }))).toBe(
      '평점 9.0 · 우메다 · 트립닷컴',
    );
  });

  it('리뷰 수는 평점이 있을 때만 붙는다', () => {
    expect(listDescription(hotel({ reviewScore: 8.8, reviewCount: 1234 }))).toBe('평점 8.8(1,234)');
    expect(listDescription(hotel({ reviewCount: 1234 }))).toBe('');
  });
});

describe('provider — 사이트별 검색과 검증', () => {
  // ⚠️ **전부 트립닷컴이다.** 허용 호스트가 트립닷컴 하나라(2026-11-10) 다른 사이트
  //    주소를 쓰면 호스트 필터에 먼저 걸려서, **검증하려던 코드가 아예 안 돌아간다.**
  const TRIP = 'https://kr.trip.com/hotels/detail/?hotelId=1';
  const CROSS = 'https://kr.trip.com/hotels/detail/?hotelId=222';
  const GRANVIA_AGAIN = 'https://kr.trip.com/hotels/detail/?hotelId=333';
  const MADE_UP = 'https://kr.trip.com/hotels/detail/?hotelId=999';

  const candidate = (name: string, url: string) => ({
    name,
    url,
    price_from: null,
    review_score: 9,
    review_count: 100,
    area: null,
    note: null,
  });

  /** 갈래별 응답. 입력문에 들어간 사이트 이름으로 가른다. */
  const respondWith = (overrides: { searchCalls?: number } = {}) => {
    const inputs: string[] = [];
    const openai = {
      enabled: true,
      webSearchToolSpec: { type: 'web_search' },
      respond: async (req: any) => {
        if (req.format?.name !== 'hotel_candidates') {
          // 2차: 받은 후보를 순서대로 전부 고른다.
          const count = (req.input.match(/^\d+\) /gm) ?? []).length;
          return { text: JSON.stringify({ picks: [...Array(count).keys()] }), searchCalls: 0, status: 'completed', ms: 1 };
        }
        inputs.push(req.input);
        const searchCalls = overrides.searchCalls ?? 1;
        if (req.input.includes('트립닷컴')) {
          return {
            text: JSON.stringify({
              candidates: [
                candidate('그란비아 (Hotel Granvia)', TRIP),
                candidate('크로스 (Cross Hotel)', CROSS),
                candidate('지어낸 호텔 (Made Up)', MADE_UP), // 출처에 없다
                // 「그란비아」와 같은 호텔을 표기만 바꿔 한 번 더 준다. 먼저 온 쪽이 남는다.
                candidate('그랑비아 (Hotel Granvia)', GRANVIA_AGAIN),
              ],
            }),
            searchCalls,
            sources: [TRIP, CROSS, GRANVIA_AGAIN],
            status: 'completed',
            ms: 1,
          };
        }
        throw new Error('openai timeout after 60000ms'); // 그 밖의 갈래는 실패
      },
    } as unknown as OpenAiService;
    return { openai, inputs };
  };

  const titles: Record<string, string> = {};
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      const title = Object.entries(titles).find(([prefix]) => url.startsWith(prefix))?.[1];
      const html = title ? `<html><head><title>${title}</title></head></html>` : '';
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
    for (const key of Object.keys(titles)) delete titles[key];
  });

  const search = (openai: OpenAiService) =>
    new OpenAiHotelProvider(loadConfig(), openai).searchTraced({
      citySlug: 'osaka',
      cityName: '오사카',
      guests: null,
      limit: 20,
    });

  it('사이트별로 검색하고, 출처에 없는 주소와 중복을 뺀다', async () => {
    const { openai, inputs } = respondWith();
    titles[CROSS] = 'Cross Hotel Osaka';
    titles[GRANVIA_AGAIN] = 'Hotel Granvia Osaka';

    const { hotels, trace } = await search(openai);

    expect(inputs).toHaveLength(SITE_BRANCHES.length);
    expect(inputs.every((input) => input.includes('site:'))).toBe(true);
    // 「지어낸 호텔」은 출처에 없어서, 「그랑비아」는 먼저 온 「그란비아」와 같은 호텔이라 빠진다.
    expect(hotels.map((h) => h.name)).toEqual(['그란비아 (Hotel Granvia)', '크로스 (Cross Hotel)']);
    expect(trace.ungrounded).toBe(1);
    expect(hotels[0].reviewCount).toBe(100);
  });

  it('검색을 안 돌고 답한 갈래는 버린다 (기억으로 쓴 답이다)', async () => {
    const { openai } = respondWith({ searchCalls: 0 });
    const { hotels } = await search(openai);
    expect(hotels).toEqual([]);
  });

  it('페이지 제목에 그 호텔 이름이 없으면 버린다', async () => {
    const { openai } = respondWith();
    // ⚠️ **중복이 아닌 줄로 검증한다.** 「그랑비아」쪽에 어긋난 제목을 달면 같은 호텔인
    //    「그란비아」와 겹쳐 **중복 제거에 먼저 걸리고**, 제목 검사는 돌지도 않는다.
    titles[CROSS] = '오사카 호텔 추천'; // 목록 페이지였다
    titles[GRANVIA_AGAIN] = 'Hotel Granvia Osaka';

    const { hotels, trace } = await search(openai);
    // 「그란비아」는 제목을 못 읽어서(빈 응답) 버리지 않는다 — 비교할 것이 없을 때
    // 버리면 멀쩡한 줄이 사라진다. 버리는 건 **이름이 어긋난 게 확인된** 줄뿐이다.
    expect(hotels.map((h) => h.name)).toEqual(['그란비아 (Hotel Granvia)']);
    expect(trace.nameMismatches).toBe(1);
  });

  it('갈래가 전부 실패하면 던진다 (실패 카드로 간다)', async () => {
    const openai = {
      enabled: true,
      webSearchToolSpec: { type: 'web_search' },
      respond: async () => {
        throw new Error('openai timeout after 60000ms');
      },
    } as unknown as OpenAiService;
    await expect(search(openai)).rejects.toThrow('openai timeout');
  });
});

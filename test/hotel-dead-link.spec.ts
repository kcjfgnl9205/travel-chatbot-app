import { loadConfig } from '../src/config/app.config';
import { OpenAiHotelProvider } from '../src/modules/hotel/providers/openai.provider';
import { OpenAiService } from '../src/modules/openai/openai.service';

/**
 * **열리지 않는 예약 링크를 버린다.**
 *
 * 호스트만 보던 때는 `kr.hotels.com/아무거나` 가 그대로 통과했다. 모델은 실재하지
 * 않는 경로를 그럴듯하게 만들어내고, 그게 애드픽 변환을 타고 사용자에게 나간다 —
 * 눌러보면 다른 지역이 뜨거나 결과가 없거나 홈으로 튕겼다. 사용자는 그걸 **우리가
 * 추천한 호텔**이라고 믿고 눌렀다.
 *
 * ⚠️ **404·410 만 죽은 것으로 본다.** 이 사이트들은 봇을 막아 403·429 를 자주 주는데,
 *    그건 "주소가 틀렸다" 가 아니라 "우리가 봇으로 보인다" 는 뜻이다. 그걸 근거로
 *    버리면 멀쩡한 줄까지 전부 사라진다.
 */
describe('provider 가 죽은 예약 링크를 버린다', () => {
  const ALIVE = 'https://kr.trip.com/hotels/osaka-detail-1/';
  // ⚠️ **허용 호스트 안에서 죽은 주소여야 한다.** 호텔스닷컴 주소를 쓰면 호스트
  //    필터에 먼저 걸려서(ALLOWED_HOSTS 는 트립닷컴 하나다) 죽은 링크 검사가 아예
  //    돌지 않는다 — 테스트는 통과하는데 검사하려던 코드는 안 돌아간다.
  const DEAD = 'https://kr.trip.com/hotels/osaka-detail-999999999/';

  const fakeOpenAi = {
    enabled: true,
    webSearchToolSpec: { type: 'web_search' },
    respond: async (req: any) => {
      if (req.format?.name === 'hotel_candidates') {
        return {
          text: JSON.stringify({
            candidates: [
              { name: '살아 있는 호텔', url: ALIVE, price_from: 100000, review_score: 9, area: '우메다', note: null },
              { name: '지어낸 호텔', url: DEAD, price_from: 90000, review_score: 8, area: '난바', note: null },
            ],
          }),
          searchCalls: 1,
          status: 'completed',
          ms: 1,
        };
      }
      return { text: JSON.stringify({ picks: [0, 1] }), searchCalls: 0, status: 'completed', ms: 1 };
    },
  } as unknown as OpenAiService;

  const response = (status: number) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      body: null,
    }) as unknown as Response;

  let restore: (() => void) | undefined;

  /** DEAD 주소에만 지정한 상태코드를 준다. 나머지는 평범한 200. */
  const stub = (deadStatus: number) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.startsWith(DEAD)) return response(deadStatus);
      // 썸네일 긁기는 여기서 관심 밖이다. 본문 없는 200 이면 그냥 사진이 안 붙는다.
      return response(200);
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  };

  afterEach(() => restore?.());

  const search = (config = loadConfig()) =>
    new OpenAiHotelProvider(config, fakeOpenAi).searchTraced({
      citySlug: 'osaka',
      cityName: '오사카',
      guests: null,
      limit: 5,
    });

  it('404 면 그 줄을 버린다', async () => {
    stub(404);
    const { hotels, trace } = await search();

    // ⚠️ 검사는 **한국어 페이지로 돌린 뒤의 주소**에 한다 (`toKoreanUrl` 이
    //    trip.com 에 locale·curr 를 붙인다). 사용자가 실제로 누르는 것이 그 주소다.
    expect(hotels).toHaveLength(1);
    expect(hotels[0].sourceUrl).toContain('kr.trip.com/hotels/osaka-detail-1/');
    expect(trace.deadLinks).toBe(1);
  });

  it('410 도 죽은 것으로 본다', async () => {
    stub(410);
    const { hotels } = await search();

    expect(hotels).toHaveLength(1);
  });

  /**
   * ⚠️ **여기가 핵심이다.** 403·429 를 죽음으로 세면 사이트가 우리를 막는 날
   *    카드가 통째로 비어버린다 — 영어 페이지를 감수하면서까지 지켜온 판단이고
   *    (`chooseUrl`), 여기서도 같다.
   */
  it('봇 차단(403·429)은 죽은 게 아니다 — 멀쩡한 줄까지 사라지면 안 된다', async () => {
    for (const status of [403, 429]) {
      stub(status);
      const { hotels, trace } = await search();

      expect(hotels).toHaveLength(2);
      expect(trace.deadLinks).toBe(0);
      restore?.();
    }
  });

  it('확인할 수 없으면(네트워크 오류) 살려둔다', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).startsWith(DEAD)) throw new Error('ECONNRESET');
      return response(200);
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const { hotels } = await search();
    expect(hotels).toHaveLength(2);
  });

  it('HOTEL_VERIFY_LINKS=false 면 확인하지 않는다', async () => {
    stub(404);
    const { hotels, trace } = await search({ ...loadConfig(), hotelVerifyLinks: false });

    expect(hotels).toHaveLength(2);
    expect(trace.deadLinks).toBe(0);
  });
});

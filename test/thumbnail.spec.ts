import { loadConfig } from '../src/config/app.config';
import { OpenAiHotelProvider } from '../src/modules/hotel/providers/openai.provider';
import { OpenAiService } from '../src/modules/openai/openai.service';
import {
  absolutize,
  declaredSize,
  decodeEntities,
  extractThumbnail,
} from '../src/modules/hotel/thumbnail';

const PAGE = 'https://kr.trip.com/hotels/osaka-hotel-detail-688242/';

/** 실제로 받아본 응답을 줄여서 고정해둔다. 사이트가 바뀌면 이 테스트가 먼저 깨져야 한다. */
const HOTELS_COM = `<html><head>
<meta property="og:title" content="호텔 세나스키"/>
<meta property="og:image" content="https://images.trvl-media.com/lodging/2000000/1160000/67499887.jpg?impolicy=resizecrop&amp;rw=598"/>
</head><body></body></html>`;

const TRIP_COM = `<html><head><title>호텔</title></head><body>
<img src="https://dimg04.tripcdn.com/images/05E3c12000nm1joaw5B34.png">
<img src="https://ak-d.tripcdn.com/images/220t180000014ip1sA616_R_960_660_R5_D.jpg">
</body></html>`;

describe('예약 페이지에서 대표 이미지 뽑기', () => {
  it('og:image 를 집고 &amp; 를 풀어준다 (안 풀면 주소가 깨진다)', () => {
    const found = extractThumbnail(HOTELS_COM, 'https://kr.hotels.com/ho224350/');
    expect(found).toEqual({
      url: 'https://images.trvl-media.com/lodging/2000000/1160000/67499887.jpg?impolicy=resizecrop&rw=598',
      source: 'og',
    });
  });

  /**
   * trip.com 은 SPA 라 og 태그가 아예 없다. 본문에서 건져야 하는데,
   * 아무거나 집으면 첫 줄의 로고 png 가 카드에 박힌다.
   */
  it('og 가 없으면 본문에서 크기가 박힌 사진만 집는다 — 로고 png 는 건너뛴다', () => {
    const found = extractThumbnail(TRIP_COM, PAGE);
    expect(found?.source).toBe('photo');
    expect(found?.url).toBe(
      'https://ak-d.tripcdn.com/images/220t180000014ip1sA616_R_960_660_R5_D.jpg',
    );
  });

  it('og:image 가 사이트 로고면 받지 않는다 (다섯 줄이 전부 같은 로고가 된다)', () => {
    const html = `<meta property="og:image" content="https://cdn.example.com/logos/mrt_main_og_image.png"/>`;
    expect(extractThumbnail(html, PAGE)).toBeNull();
  });

  it('로고를 건너뛰고 아래층에서 진짜 사진을 찾는다', () => {
    const html =
      `<meta property="og:image" content="https://cdn.example.com/logos/site_logo.png"/>` +
      `<img src="https://cdn.example.com/photos/room_1200x800.jpg">`;
    expect(extractThumbnail(html, PAGE)).toEqual({
      url: 'https://cdn.example.com/photos/room_1200x800.jpg',
      source: 'photo',
    });
  });

  it('JSON-LD 의 image 도 본다', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Hotel","name":"호텔","image":"https://cdn.example.com/hotel/main.jpg"}
    </script>`;
    expect(extractThumbnail(html, PAGE)).toEqual({
      url: 'https://cdn.example.com/hotel/main.jpg',
      source: 'ld',
    });
  });

  it('twitter:image 로도 떨어진다', () => {
    const html = `<meta name="twitter:image" content="/img/room.jpg">`;
    expect(extractThumbnail(html, PAGE)?.url).toBe('https://kr.trip.com/img/room.jpg');
  });

  it('작은 이미지는 사진이 아니다 — 아이콘이 카드에 박히면 안 된다', () => {
    const html = `<img src="https://cdn.example.com/icon_120x120.jpg">`;
    expect(extractThumbnail(html, PAGE)).toBeNull();
  });

  it('아무것도 없으면 null — 깨진 이미지보다 없는 게 낫다', () => {
    expect(extractThumbnail('<html><body>내용 없음</body></html>', PAGE)).toBeNull();
  });
});

describe('주소 정규화', () => {
  it('상대 주소를 페이지 기준으로 절대 주소로 만든다', () => {
    expect(absolutize('/img/a.jpg', PAGE)).toBe('https://kr.trip.com/img/a.jpg');
    expect(absolutize('//cdn.example.com/a.jpg', PAGE)).toBe('https://cdn.example.com/a.jpg');
  });

  /** 카카오는 http 이미지를 렌더링하지 않는다. 넣어봐야 빈 자리만 남는다. */
  it('http 이미지는 받지 않는다', () => {
    expect(absolutize('http://cdn.example.com/a.jpg', PAGE)).toBeNull();
  });

  it('엔티티를 푼다', () => {
    expect(decodeEntities('a&amp;b&#39;c')).toBe("a&b'c");
  });
});

describe('URL 이 스스로 밝히는 크기', () => {
  it('trip.com 표기', () => {
    expect(declaredSize('https://x/220t18_R_960_660_R5_D.jpg')).toEqual({ w: 960, h: 660 });
    expect(declaredSize('https://x/220t18_W_480_360_R5_Q70.jpg')).toEqual({ w: 480, h: 360 });
  });

  it('일반 표기', () => {
    expect(declaredSize('https://x/room_1200x800.jpg')).toEqual({ w: 1200, h: 800 });
  });

  it('크기를 안 밝히면 null — 로고·아이콘이 그렇다', () => {
    expect(declaredSize('https://x/logo.png')).toBeNull();
  });
});

/**
 * 여기가 실제 동작이다. 추출기가 아무리 정확해도 provider 가 안 부르면 소용없다.
 *
 * 원래 이 파이프라인은 **이미지를 절대 못 채웠다** — 1차 후보 스키마에 이미지 필드가
 * 없어서 모델이 줄 수가 없었고, 2차는 "후보에 없는 건 null" 규칙을 지켰다.
 * 그래서 예약 페이지를 직접 읽는 경로가 유일한 답이다.
 */
describe('provider 가 예약 페이지에서 이미지를 붙인다', () => {
  const PAGE_HOST = 'kr.trip.com';
  const HOTEL_URL = 'https://kr.trip.com/hotels/osaka-detail-1/';
  const PHOTO = 'https://ak-d.tripcdn.com/images/220t18_R_960_660_R5_D.jpg';
  const HTML = `<html><body><img src="${PHOTO}"></body></html>`;

  /** 모델은 이미지 주소를 모른다 — thumbnail_url 은 항상 null 로 온다. */
  const fakeOpenAi = {
    enabled: true,
    webSearchToolSpec: { type: 'web_search' },
    respond: async (req: any) => {
      const name = req.format?.name;
      if (name === 'hotel_candidates') {
        return {
          text: JSON.stringify({
            candidates: [
              { name: '호텔 A', url: HOTEL_URL, price_from: 100000, review_score: 9, area: '우메다', note: null },
            ],
          }),
          searchCalls: 1,
          status: 'completed',
          ms: 1,
        };
      }
      return {
        text: JSON.stringify({
          hotels: [
            {
              name: '호텔 A',
              source_url: HOTEL_URL,
              merchant: 'trip',
              address: null,
              star_rating: null,
              review_score: 9,
              price_from: 100000,
              thumbnail_url: null,
              description: null,
              tags: ['우메다'],
            },
          ],
        }),
        searchCalls: 0,
        status: 'completed',
        ms: 1,
      };
    },
  } as unknown as OpenAiService;

  /** 페이지 응답은 스트림으로 온다 — provider 가 앞부분만 읽고 끊기 때문이다. */
  const htmlResponse = (html: string) =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(html));
          c.close();
        },
      }),
    }) as unknown as Response;

  const imageResponse = (contentType: string | null) =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(contentType ? { 'content-type': contentType } : {}),
      body: null,
    }) as unknown as Response;

  let restore: () => void;
  const stub = (imageType: string | null, pageOk = true) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      if (url.hostname === PAGE_HOST) {
        if (!pageOk) throw new Error('403 봇 차단');
        return htmlResponse(HTML);
      }
      return imageResponse(imageType);
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  };

  afterEach(() => restore?.());

  const search = () =>
    new OpenAiHotelProvider(loadConfig(), fakeOpenAi).searchTraced({
      citySlug: 'osaka',
      cityName: '오사카',
      guests: null,
      limit: 5,
    });

  it('모델이 null 을 줘도 페이지에서 긁어 채운다', async () => {
    stub('image/jpeg');
    const { hotels, trace } = await search();

    expect(hotels[0].thumbnailUrl).toBe(PHOTO);
    expect(trace.thumbnails).toBe(1);
    expect(trace.thumbnailSources).toEqual({ photo: 1 });
  });

  /** trip.com CDN 이 실제로 이렇다. 없다고 버리면 이미지를 다 놓친다. */
  it('CDN 이 content-type 을 안 줘도 200 이면 받는다', async () => {
    stub(null);
    const { hotels } = await search();
    expect(hotels[0].thumbnailUrl).toBe(PHOTO);
  });

  it('이미지가 아니면 버린다 — 깨진 자리보다 없는 게 낫다', async () => {
    stub('text/html');
    const { hotels, trace } = await search();
    expect(hotels[0].thumbnailUrl).toBeNull();
    expect(trace.droppedThumbnails).toBe(1);
  });

  it('페이지를 못 읽어도 호텔은 그대로 나간다 (이미지만 없다)', async () => {
    stub('image/jpeg', false);
    const { hotels, trace } = await search();
    expect(hotels).toHaveLength(1);
    expect(hotels[0].thumbnailUrl).toBeNull();
    expect(trace.thumbnails).toBe(0);
  });
});

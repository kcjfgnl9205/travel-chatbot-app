import {
  FoundPlace,
  findPlace,
  toFoundPlace,
} from '../src/modules/attraction/attraction-place';
import { mapsUrl } from '../src/common/maps-url';

/**
 * 구글 Places 응답을 우리 값으로 옮기는 지점.
 *
 * 모델이 준 값과 달리 여기 오는 건 **사실**이지만, 그렇다고 검증 없이 받지는 않는다 —
 * 필드가 아예 없거나(요청한 티어에 없으면 안 온다) 모양이 다를 수 있다.
 * 반쪽짜리 영업시간이나 범위를 벗어난 평점은 없는 것보다 나쁘다.
 */

const OPTS = { apiKey: 'k', timeoutMs: 100, ratings: true };

describe('Places 응답 해석', () => {
  it('필요한 것만 뽑는다', () => {
    const place = toFoundPlace({
      id: 'ChIJ_osaka_castle',
      formattedAddress: '일본 오사카부 오사카시 주오구',
      location: { latitude: 34.6873, longitude: 135.5259 },
      rating: 4.4,
      userRatingCount: 61234,
      regularOpeningHours: { weekdayDescriptions: ['월요일: 오전 9:00~오후 5:00'] },
      websiteUri: 'https://www.osakacastle.net/',
    });

    expect(place).toEqual<FoundPlace>({
      placeId: 'ChIJ_osaka_castle',
      address: '일본 오사카부 오사카시 주오구',
      lat: 34.6873,
      lng: 135.5259,
      rating: 4.4,
      userRatingCount: 61234,
      openingHours: ['월요일: 오전 9:00~오후 5:00'],
      website: 'https://www.osakacastle.net/',
    });
  });

  /** place_id 가 이 장소의 신원이다. 그게 없으면 나머지가 있어도 쓸 데가 없다. */
  it('place_id 가 없으면 통째로 버린다', () => {
    expect(toFoundPlace({ formattedAddress: '어딘가', rating: 4.5 })).toBeNull();
  });

  /**
   * 싼 티어(Essentials)로 부르면 평점·운영시간은 **응답에 아예 없다.**
   * 그게 정상이므로 나머지는 그대로 살아야 한다.
   */
  it('티어에 없는 필드가 빠져 와도 나머지는 산다', () => {
    const place = toFoundPlace({
      id: 'ChIJ_x',
      formattedAddress: '주소',
      location: { latitude: 1.1, longitude: 2.2 },
    });

    expect(place).toMatchObject({ placeId: 'ChIJ_x', rating: null, openingHours: null });
  });

  it('범위를 벗어난 평점은 버린다', () => {
    // 5점 만점인데 10점 스케일이 오면 우리가 잘못 읽은 것이다.
    expect(toFoundPlace({ id: 'x', rating: 8.7 })?.rating).toBeNull();
    expect(toFoundPlace({ id: 'x', userRatingCount: -3 })?.userRatingCount).toBeNull();
  });

  /** 반쪽짜리 영업시간은 "월·화만 영업" 처럼 읽힌다. 없는 것보다 나쁘다. */
  it('영업시간에 문자열이 아닌 게 섞이면 통째로 버린다', () => {
    const place = toFoundPlace({
      id: 'x',
      regularOpeningHours: { weekdayDescriptions: ['월요일: 종일', null, 42] },
    });

    expect(place?.openingHours).toBeNull();
  });

  it('http 홈페이지는 받지 않는다', () => {
    expect(toFoundPlace({ id: 'x', websiteUri: 'http://old.example.com' })?.website).toBeNull();
    expect(toFoundPlace({ id: 'x', websiteUri: '홈페이지 없음' })?.website).toBeNull();
  });
});

describe('Places 호출', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  function stub(handler: (url: string, init: RequestInit) => Response) {
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) =>
      Promise.resolve(handler(String(url), init))) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  }

  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('이름에 도시를 붙여 찾는다 — "중앙공원" 은 전 세계에 있다', async () => {
    let sent: Record<string, unknown> = {};
    stub((_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return ok({ places: [{ id: 'ChIJ_1' }] });
    });

    await findPlace('중앙공원', '오사카', OPTS);

    expect(sent.textQuery).toBe('중앙공원 오사카');
  });

  /**
   * ⚠️ 필드 마스크가 곧 요금이다. 평점을 안 쓸 때는 싼 티어 필드만 요청해야 한다.
   */
  it('평점을 안 쓰면 비싼 필드를 요청하지 않는다', async () => {
    let mask = '';
    stub((_url, init) => {
      mask = String((init.headers as Record<string, string>)['X-Goog-FieldMask']);
      return ok({ places: [{ id: 'ChIJ_1' }] });
    });

    await findPlace('오사카성', '오사카', { ...OPTS, ratings: false });

    expect(mask).toContain('places.id');
    expect(mask).toContain('places.location');
    expect(mask).not.toContain('rating');
    expect(mask).not.toContain('regularOpeningHours');
  });

  it('평점을 켜면 그 필드까지 요청한다', async () => {
    let mask = '';
    stub((_url, init) => {
      mask = String((init.headers as Record<string, string>)['X-Goog-FieldMask']);
      return ok({ places: [{ id: 'ChIJ_1' }] });
    });

    await findPlace('오사카성', '오사카', { ...OPTS, ratings: true });

    expect(mask).toContain('places.rating');
    expect(mask).toContain('places.userRatingCount');
  });

  it('못 찾으면 null — 흔한 일이다', async () => {
    stub(() => ok({}));
    expect(await findPlace('없는곳', '오사카', OPTS)).toBeNull();
  });

  /** 구글이 느리거나 죽어도 관광지 추천은 나가야 한다. */
  it('오류를 삼킨다', async () => {
    stub(() => new Response('quota exceeded', { status: 429 }));
    expect(await findPlace('오사카성', '오사카', OPTS)).toBeNull();
  });
});

describe('지도 링크', () => {
  it('place_id 가 있으면 검색이 아니라 그 장소를 정확히 연다', () => {
    const url = mapsUrl('오사카성', '오사카', 'ChIJ_osaka');

    expect(url).toContain('query_place_id=ChIJ_osaka');
    // 구글 규약이 query 도 함께 요구한다.
    expect(url).toContain(`query=${encodeURIComponent('오사카성 오사카')}`);
  });

  it('없으면 지금까지처럼 이름으로 검색한다', () => {
    expect(mapsUrl('오사카성', '오사카')).not.toContain('query_place_id');
  });
});

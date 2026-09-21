import {
  PLACE_TYPES,
  areaOf,
  searchCityAttractions,
  toCandidate,
} from '../src/modules/attraction/attraction-place';
import { mapsUrl } from '../src/common/maps-url';

/**
 * 구글 Places 응답을 우리 값으로 옮기는 지점.
 *
 * **여기가 관광지 목록의 출처다.** 모델이 아니라 구글이 "어떤 곳이 있나" 를 정하므로,
 * 폐관한 곳이나 없는 곳이 들어올 자리가 없다. 대신 응답 모양이 티어·언어에 따라
 * 달라지므로 빠진 필드를 견디는 게 이 파일의 일이다.
 */

const OPTS = { apiKey: 'k', timeoutMs: 100 };

describe('Places 응답 해석', () => {
  it('필요한 것만 뽑는다', () => {
    const c = toCandidate(
      {
        id: 'ChIJ_osaka_castle',
        displayName: { text: '오사카성' },
        formattedAddress: '일본 오사카부 오사카시 주오구',
        addressComponents: [
          { types: ['sublocality_level_1', 'political'], longText: '주오구' },
          { types: ['locality'], longText: '오사카시' },
        ],
        location: { latitude: 34.6873, longitude: 135.5259 },
        rating: 4.4,
        userRatingCount: 61234,
      },
      '역사/문화',
    );

    expect(c).toEqual({
      placeId: 'ChIJ_osaka_castle',
      name: '오사카성',
      area: '주오구',
      address: '일본 오사카부 오사카시 주오구',
      lat: 34.6873,
      lng: 135.5259,
      rating: 4.4,
      userRatingCount: 61234,
      category: '역사/문화',
    });
  });

  /** place_id 는 신원이고 이름은 카드 제목이다. 둘 중 하나만 없어도 쓸 데가 없다. */
  it('신원이나 이름이 없으면 버린다', () => {
    expect(toCandidate({ displayName: { text: '오사카성' } }, '역사/문화')).toBeNull();
    expect(toCandidate({ id: 'ChIJ_1' }, '역사/문화')).toBeNull();
  });

  it('평점이 없어도 나머지는 산다 — 리뷰가 없는 장소가 있다', () => {
    const c = toCandidate({ id: 'ChIJ_1', displayName: { text: '작은 사원' } }, '역사/문화');

    expect(c).toMatchObject({ placeId: 'ChIJ_1', rating: null, userRatingCount: null });
  });

  it('범위를 벗어난 평점은 버린다', () => {
    // 5점 만점인데 10점 스케일이 오면 우리가 잘못 읽은 것이다.
    const c = toCandidate({ id: 'x', displayName: { text: 'n' }, rating: 8.7 }, 'c');
    expect(c?.rating).toBeNull();
  });
});

describe('도시 안에서의 위치', () => {
  /** 카드에 도시 이름을 다시 쓰는 건 의미가 없다 — 사용자는 이미 그 도시를 물었다. */
  it('도시(locality)가 아니라 그 아래 단위를 고른다', () => {
    const area = areaOf([
      { types: ['locality'], longText: '오사카시' },
      { types: ['sublocality_level_1'], longText: '주오구' },
    ]);

    expect(area).toBe('주오구');
  });

  it('좁은 단위가 없으면 다음 단위로 내려간다', () => {
    expect(areaOf([{ types: ['neighborhood'], longText: '우메다' }])).toBe('우메다');
  });

  it('쓸 게 없으면 null — 그 조각만 빠진다', () => {
    expect(areaOf([{ types: ['country'], longText: '일본' }])).toBeNull();
    expect(areaOf(undefined)).toBeNull();
  });
});

describe('도시 후보 수집', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  function stub(handler: (body: Record<string, unknown>, mask: string) => unknown) {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const mask = String((init.headers as Record<string, string>)['X-Goog-FieldMask']);
      return Promise.resolve(
        new Response(JSON.stringify(handler(body, mask)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  }

  /**
   * ⚠️ 한 번에 "오사카 관광지" 로 부르면 비슷한 성격이 스무 곳 나온다.
   *    타입을 갈라 부르는 것이 곧 카테고리 다양성이다.
   */
  it('타입마다 한 번씩 부른다', async () => {
    const types: unknown[] = [];
    stub((body) => {
      types.push(body.includedType);
      return { places: [] };
    });

    await searchCityAttractions('오사카', OPTS);

    expect(types).toEqual(PLACE_TYPES.map((t) => t.type));
  });

  it('같은 장소가 여러 타입에 걸리면 한 번만 남는다', async () => {
    // 오사카성은 tourist_attraction 이자 historical_landmark 다.
    stub(() => ({
      places: [{ id: 'ChIJ_same', displayName: { text: '오사카성' } }],
    }));

    const found = await searchCityAttractions('오사카', OPTS);

    expect(found).toHaveLength(1);
    // 먼저 걸린 타입의 카테고리를 쓴다 — PLACE_TYPES 순서가 곧 우선순위다.
    expect(found[0].category).toBe(PLACE_TYPES[0].category);
  });

  /** 여섯 번 중 한 번이 죽었다고 그 도시를 통째로 포기하면 안 된다. */
  it('한 타입이 실패해도 나머지로 목록을 만든다', async () => {
    let call = 0;
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('boom'));
      const body = JSON.parse(String(init.body)) as { includedType?: string };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            places: [{ id: `ChIJ_${body.includedType}`, displayName: { text: '어딘가' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const found = await searchCityAttractions('오사카', OPTS);

    expect(found).toHaveLength(PLACE_TYPES.length - 1);
  });

  it('검색어에 도시를 넣는다 — "중앙공원" 은 전 세계에 있다', async () => {
    const queries: unknown[] = [];
    stub((body) => {
      queries.push(body.textQuery);
      return { places: [] };
    });

    await searchCityAttractions('오사카', OPTS);

    for (const q of queries) expect(String(q)).toContain('오사카');
  });

  /** ⚠️ 필드 마스크가 곧 요금이다. 안 쓰는 필드를 요청하면 그만큼 비싸진다. */
  it('사진은 요청하지 않는다 — 주소가 만료돼서 안 쓴다', async () => {
    let mask = '';
    stub((_body, m) => {
      mask = m;
      return { places: [] };
    });

    await searchCityAttractions('오사카', OPTS);

    expect(mask).toContain('places.id');
    expect(mask).toContain('places.rating');
    expect(mask).not.toContain('photo');
  });
});

describe('지도 링크', () => {
  it('place_id 가 있으면 검색이 아니라 그 장소를 정확히 연다', () => {
    const url = mapsUrl('오사카성', '오사카', 'ChIJ_osaka');

    expect(url).toContain('query_place_id=ChIJ_osaka');
    // 구글 규약이 query 도 함께 요구한다.
    expect(url).toContain(`query=${encodeURIComponent('오사카성 오사카')}`);
  });

  it('없으면 이름으로 검색한다', () => {
    expect(mapsUrl('오사카성', '오사카')).not.toContain('query_place_id');
  });
});

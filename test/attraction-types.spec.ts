import { mapsUrl } from '../src/common/maps-url';
import { listDescription, ratingText } from '../src/modules/attraction/attraction-card';
import { AttractionService, dedupe } from '../src/modules/attraction/attraction.service';
import { Attraction, attractionKey, isAttraction } from '../src/modules/attraction/attraction.types';

/**
 * 관광지 카드 문구와 중복 판정.
 *
 * 입장료·소요시간이 있던 자리에 **구글 평점**이 들어왔다. 구글이 입장료를 주지 않고
 * 모델은 지어내서 아예 안 모으기로 했기 때문이다 — 틀린 가격은 없는 가격보다 나쁘다.
 */

function spot(over: Partial<Attraction> = {}): Attraction {
  return {
    placeId: 'ChIJ_osaka_castle',
    name: '오사카성',
    citySlug: 'osaka',
    category: '역사/문화',
    area: '주오구',
    rating: 4.4,
    userRatingCount: 61234,
    mapUrl: mapsUrl('오사카성', '오사카', 'ChIJ_osaka_castle'),
    ...over,
  };
}

describe('평점 표기', () => {
  /** 평점 4.8 에 리뷰 3개는 4.3 에 리뷰 5만 개보다 못 믿는다. 둘을 같이 보여준다. */
  it('별점과 리뷰 수를 같이 낸다', () => {
    expect(ratingText(spot())).toBe('★ 4.4 (61,234)');
  });

  it('리뷰 수를 모르면 별점만', () => {
    expect(ratingText(spot({ userRatingCount: null }))).toBe('★ 4.4');
  });

  it('평점이 없으면 빈 문자열 — 그 조각을 통째로 뺀다', () => {
    expect(ratingText(spot({ rating: null }))).toBe('');
  });

  it('소수점 한 자리로 고정한다', () => {
    expect(ratingText(spot({ rating: 4, userRatingCount: 12 }))).toBe('★ 4.0 (12)');
  });
});

describe('listCard 한 줄 (40자)', () => {
  it('평점 · 카테고리 · 위치 순으로 넣는다', () => {
    expect(listDescription(spot())).toBe('★ 4.4 (61,234) · 역사/문화 · 주오구');
  });

  it('없는 조각은 건너뛴다', () => {
    expect(listDescription(spot({ rating: null, area: null }))).toBe('역사/문화');
  });

  it('전부 없으면 빈 줄 — 카드는 이름만으로도 나간다', () => {
    expect(listDescription(spot({ rating: null, category: null, area: null }))).toBe('');
  });
});

describe('중복 판정', () => {
  /**
   * 이름으로 판정하면 '오사카성' / '오사카 성' / 'Osaka Castle' 이 전부 다른 값이 된다.
   * place_id 는 구글이 부여한 신원이라 표기와 무관하게 같다.
   */
  it('표기가 달라도 place_id 가 같으면 같은 곳이다', () => {
    const a = spot({ name: '오사카성' });
    const b = spot({ name: '오사카 성', mapUrl: 'https://다른주소' });

    expect(attractionKey(a)).toBe(attractionKey(b));
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it('place_id 가 다르면 이름이 같아도 다른 곳이다', () => {
    const a = spot({ placeId: 'ChIJ_1' });
    const b = spot({ placeId: 'ChIJ_2' });

    expect(dedupe([a, b])).toHaveLength(2);
  });

  it('먼저 온 것을 남긴다 — 추천 순서가 곧 우선순위다', () => {
    const first = spot({ placeId: 'ChIJ_1', name: '첫째' });
    const second = spot({ placeId: 'ChIJ_2', name: '둘째' });

    expect(dedupe([first, second, first]).map((a) => a.name)).toEqual(['첫째', '둘째']);
  });
});

describe('캐시에서 살려낸 값', () => {
  it('모양이 맞으면 통과', () => {
    expect(isAttraction(spot())).toBe(true);
  });

  it('배포로 필드가 바뀌어 모양이 깨지면 버린다', () => {
    expect(isAttraction({ name: '오사카성' })).toBe(false);
    expect(isAttraction(null)).toBe(false);
  });
});

describe('목록의 영구 신원', () => {
  /**
   * ⚠️ **배치 경로에만 두면 두 경로가 달라진다.** 사용자가 물어서 찾은 도시는 30일
   *    캐시에만 있고, 그 캐시가 비면 목록을 처음부터 다시 만들어야 한다(모델 재호출).
   *    place_id 가 남아 있으면 구글에 다시 물어 살만 채우면 된다.
   */
  it('검색하면 place_id 를 도시별로 저장한다', async () => {
    const saved: { cityId: number; placeIds: string[] }[] = [];
    const provider = {
      name: 'fake',
      search: async () => [spot({ placeId: 'ChIJ_1' }), spot({ placeId: 'ChIJ_2' })],
    } as never;
    const catalog = {
      replaceCity: async (cityId: number, placeIds: string[]) => {
        saved.push({ cityId, placeIds });
        return [];
      },
    } as never;

    await new AttractionService(provider, {} as never, catalog).search({
      kind: 'attraction',
      place: { id: 42, canonicalName: '오사카', slug: 'osaka', kind: 'city',
               countryCode: 'JP', iata: 'KIX', parentId: null },
      parent: null,
      from: null,
      tripType: 'rt',
      limit: 20,
    });

    expect(saved).toEqual([{ cityId: 42, placeIds: ['ChIJ_1', 'ChIJ_2'] }]);
  });

  it('빈손이면 저장하지 않는다 — 목록을 지워버리면 안 된다', async () => {
    let called = false;
    const provider = { name: 'fake', search: async () => [] } as never;
    const catalog = {
      replaceCity: async () => {
        called = true;
        return [];
      },
    } as never;

    await new AttractionService(provider, {} as never, catalog).search({
      kind: 'attraction',
      place: { id: 42, canonicalName: '오사카', slug: 'osaka', kind: 'city',
               countryCode: 'JP', iata: 'KIX', parentId: null },
      parent: null,
      from: null,
      tripType: 'rt',
      limit: 20,
    });

    expect(called).toBe(false);
  });
});

import { mapsUrl } from '../src/common/maps-url';
import { listDescription } from '../src/modules/attraction/attraction-card';
import { dedupe } from '../src/modules/attraction/attraction.service';
import { toAttraction, httpsOnly } from '../src/modules/attraction/providers/db.provider';
import {
  Attraction,
  AttractionQuery,
  attractionKey,
  isAttraction,
} from '../src/modules/attraction/attraction.types';

/**
 * 관광지 카드 문구와 중복 판정.
 *
 * **0009 에서 카드 한 줄이 위치 하나로 줄었다.** 평점·카테고리는 구글 콘텐츠였고,
 * `rating` 을 요청하면 Text Search 가 Enterprise SKU 가 되는데 그 무료 한도가 월
 * 1,000회뿐이라 API 자체를 끊었다. 남은 건 사람이 관리 화면에서 넣는 값뿐이다.
 */

function spot(over: Partial<Attraction> = {}): Attraction {
  return {
    id: 1,
    name: '오사카성',
    citySlug: 'osaka',
    area: '주오구',
    mapUrl: mapsUrl('오사카성', '오사카'),
    ...over,
  };
}

describe('listCard 한 줄 (40자)', () => {
  it('위치를 넣는다 — 지금 넣을 게 이것뿐이다', () => {
    expect(listDescription(spot())).toBe('주오구');
  });

  it('위치가 없으면 빈 줄 — 카드는 이름만으로도 나간다', () => {
    expect(listDescription(spot({ area: null }))).toBe('');
    expect(listDescription(spot({ area: undefined }))).toBe('');
  });

  it('공백만 있는 위치도 빈 줄로 본다', () => {
    expect(listDescription(spot({ area: '   ' }))).toBe('');
  });
});

describe('중복 판정', () => {
  /**
   * 이름으로 판정하면 관리 화면에서 표기를 고치는 순간 다른 곳이 된다.
   * DB id 는 그대로다.
   */
  it('표기가 달라도 id 가 같으면 같은 곳이다', () => {
    const a = spot({ name: '오사카성' });
    const b = spot({ name: '오사카 성', mapUrl: 'https://다른주소' });

    expect(attractionKey(a)).toBe(attractionKey(b));
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it('id 가 다르면 이름이 같아도 다른 곳이다', () => {
    expect(dedupe([spot({ id: 1 }), spot({ id: 2 })])).toHaveLength(2);
  });

  it('먼저 온 것을 남긴다 — 노출 순서가 곧 우선순위다', () => {
    const first = spot({ id: 1, name: '첫째' });
    const second = spot({ id: 2, name: '둘째' });

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

describe('DB 행 → 카드 값', () => {
  const query: AttractionQuery = {
    cityId: 42,
    citySlug: 'osaka',
    cityName: '오사카',
    limit: 20,
  };

  it('평범한 행을 옮긴다', () => {
    expect(
      toAttraction(
        { id: 7, name: '오사카성', area: '주오구', image_url: 'https://cdn/a.jpg', rank: 0 },
        query,
      ),
    ).toEqual({
      id: 7,
      name: '오사카성',
      citySlug: 'osaka',
      area: '주오구',
      imageUrl: 'https://cdn/a.jpg',
      mapUrl: mapsUrl('오사카성', '오사카'),
    });
  });

  it('⚠️ 이름이 없으면 버린다 — 제목이 빈 줄은 카드에 못 쓴다', () => {
    expect(toAttraction({ id: 7, name: '  ', area: '주오구' }, query)).toBeNull();
    expect(toAttraction({ id: 7, name: null }, query)).toBeNull();
  });

  it('위치·사진은 없어도 된다', () => {
    const a = toAttraction({ id: 7, name: '오사카성' }, query);
    expect(a?.area).toBeNull();
    expect(a?.imageUrl).toBeNull();
  });
});

describe('사진 주소 검사', () => {
  /**
   * ⚠️ **카카오는 http 이미지를 그리지 않는다.** 통과시키면 카드에 깨진 자리가
   *    남으므로 "사진 없음" 으로 떨어뜨린다.
   */
  it('https 만 받는다', () => {
    expect(httpsOnly('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
    expect(httpsOnly('http://cdn.example.com/a.jpg')).toBeNull();
  });

  it('주소가 아니면 없는 것으로 친다', () => {
    expect(httpsOnly('그냥 글자')).toBeNull();
    expect(httpsOnly('')).toBeNull();
    expect(httpsOnly(null)).toBeNull();
    expect(httpsOnly(undefined)).toBeNull();
  });
});

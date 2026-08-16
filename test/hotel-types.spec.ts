import { Hotel, listDescription } from '../src/modules/hotel/hotel.types';
import { dedupe } from '../src/modules/hotel/hotel.service';

const hotel = (over: Partial<Hotel> = {}): Hotel => ({
  name: '테스트 호텔',
  citySlug: 'osaka',
  sourceUrl: '',
  ...over,
});

describe('호텔 표현', () => {
  it('있는 필드만 이어 붙인다', () => {
    expect(
      listDescription(hotel({ priceFrom: 120000, reviewScore: 8.8, tags: ['우메다', '가성비'] })),
    ).toBe('1박 120,000원~ · 평점 8.8 · 우메다');
  });

  it('AI/크롤링 결과는 필드가 비어 올 수 있다', () => {
    expect(listDescription(hotel())).toBe('가격 문의');
  });
});

describe('중복 제거', () => {
  it('AI 가 같은 호텔을 이름만 다르게 줘도 하나만 남긴다', () => {
    const result = dedupe([
      hotel({ name: '호텔 그란비아 오사카', sourceUrl: 'https://a/1' }),
      hotel({ name: 'Hotel Granvia Osaka', sourceUrl: 'https://a/1' }),
      hotel({ name: '크로스 호텔 오사카', sourceUrl: 'https://a/2' }),
    ]);
    expect(result.map((h) => h.sourceUrl)).toEqual(['https://a/1', 'https://a/2']);
    expect(result[0].name).toBe('호텔 그란비아 오사카'); // 먼저 온 쪽을 남긴다
  });

  it('sourceUrl 이 없으면 이름으로 판정한다', () => {
    expect(
      dedupe([hotel({ name: '같은 호텔' }), hotel({ name: '같은 호텔' }), hotel({ name: '다른 호텔' })]),
    ).toHaveLength(2);
  });

  it('sourceUrl 이 호텔의 신원이다 — 이름은 못 믿는다', () => {
    const a = hotel({ name: '호텔 그란비아 오사카', sourceUrl: 'https://a/1' });
    const b = hotel({ name: 'Hotel Granvia Osaka', sourceUrl: 'https://a/1' });
    expect(a.name).not.toBe(b.name);
    expect(a.sourceUrl).toBe(b.sourceUrl);
  });
});

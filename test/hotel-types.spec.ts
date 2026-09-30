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

describe('같은 호텔 판정 — 주소 하나로는 안 된다', () => {
  /**
   * ⚠️ **운영에서 "호텔이 한 개만 나온다" 로 드러난 자리다.**
   *    모델이 호텔마다 다른 예약 페이지를 줘야 하는데, 검색 결과 페이지 하나를
   *    여러 곳에 붙이면 주소 기준 판정에서 전부 같은 키가 되어 한 줄만 남는다.
   *    항공권에서 이미 겪은 실패인데(dedupe.ts 주석) 호텔에서도 났다.
   */
  it('여러 호텔이 같은 목록 페이지를 가리켜도 접히지 않는다', () => {
    const LIST = 'https://kr.trip.com/hotels/osaka-list';
    const result = dedupe([
      hotel({ name: '호텔 A', sourceUrl: LIST }),
      hotel({ name: '호텔 B', sourceUrl: LIST }),
      hotel({ name: '호텔 C', sourceUrl: LIST }),
    ]);

    expect(result.map((h) => h.name)).toEqual(['호텔 A', '호텔 B', '호텔 C']);
  });

  /** 그렇다고 원래 하던 일을 잃으면 안 된다 — 같은 호텔 페이지는 여전히 하나다. */
  it('같은 호텔 페이지는 이름이 달라도 하나로 묶는다', () => {
    const PAGE = 'https://kr.trip.com/hotels/osaka-detail-1/';
    const result = dedupe([
      hotel({ name: '호텔 그란비아 오사카', sourceUrl: PAGE }),
      hotel({ name: 'Hotel Granvia Osaka', sourceUrl: PAGE }),
    ]);

    expect(result).toHaveLength(1);
  });

  it('주소가 없으면 이름으로 판정한다', () => {
    const result = dedupe([
      hotel({ name: '호텔 A', sourceUrl: '' }),
      hotel({ name: '호텔 A', sourceUrl: '' }),
      hotel({ name: '호텔 B', sourceUrl: '' }),
    ]);

    expect(result.map((h) => h.name)).toEqual(['호텔 A', '호텔 B']);
  });

  /** 목록 페이지로 넘어간 뒤에도 표기 차이는 이름 정규화가 받는다. */
  it('목록 페이지를 공유해도 같은 이름은 한 번만 남는다', () => {
    const LIST = 'https://kr.trip.com/hotels/osaka-list';
    const result = dedupe([
      hotel({ name: '호텔 그란비아', sourceUrl: LIST }),
      hotel({ name: '호텔그란비아', sourceUrl: LIST }),
      hotel({ name: '칸데오 호텔', sourceUrl: LIST }),
      hotel({ name: '다이와 로이넷', sourceUrl: LIST }),
    ]);

    expect(result.map((h) => h.name)).toEqual(['호텔 그란비아', '칸데오 호텔', '다이와 로이넷']);
  });

  /**
   * ⚠️ **"한 개만 나온다" 가 두 번째로 난 자리다.**
   *
   * 처음 고칠 때는 "한 주소에 **서로 다른 이름**이 셋 이상" 을 목록 페이지 신호로
   * 삼았다. 그런데 모델이 같은 호텔 둘을 열 번씩 되풀이해 주면 줄은 스물인데 이름
   * 종류는 둘뿐이라 신호에 안 걸리고, 주소로 묶여 **한 줄만 남는다.** 고치려던 그
   * 증상이 그대로 난다.
   *
   * 그래서 **이름 종류가 아니라 항목 수를 센다.** 스무 줄이 한 주소를 가리킨다는
   * 사실 자체가 그 주소가 신원이 아니라는 신호다.
   */
  it('같은 주소에 스무 줄이 달렸는데 이름이 둘뿐이어도 접히지 않는다', () => {
    const LIST = 'https://kr.trip.com/hotels/osaka-list';
    const result = dedupe(
      [...Array(20).keys()].map((i) =>
        hotel({
          name: i % 2 ? '호텔 그란비아 오사카' : 'Hotel Granvia Osaka',
          sourceUrl: LIST,
        }),
      ),
    );

    // 정말로 호텔이 둘이었던 것이므로 두 줄이 맞다. 한 줄로 접히면 안 된다.
    expect(result).toHaveLength(2);
  });

  /**
   * ⚠️ 한 주소에 이름이 **둘**이면 목록 페이지가 아니라 표기 차이로 본다.
   *    한글과 영문은 문자열로 견줄 수 없어 주소가 유일한 다리다.
   */
  it('이름이 둘뿐이면 같은 호텔의 표기 차이로 본다', () => {
    const PAGE = 'https://kr.trip.com/hotels/osaka-detail-1/';
    const result = dedupe([
      hotel({ name: '호텔 그란비아 오사카', sourceUrl: PAGE }),
      hotel({ name: 'Hotel Granvia Osaka', sourceUrl: PAGE }),
    ]);

    expect(result).toHaveLength(1);
  });
});

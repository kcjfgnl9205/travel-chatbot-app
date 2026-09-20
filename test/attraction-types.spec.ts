import { mapsUrl } from '../src/common/maps-url';
import { admissionText, listDescription } from '../src/modules/attraction/attraction-card';
import {
  Attraction,
  attractionKey,
  isAttraction,
} from '../src/modules/attraction/attraction.types';
import { dedupe } from '../src/modules/attraction/attraction.service';
import { area, placeName } from '../src/modules/attraction/providers/openai.provider';
import * as t from '../src/modules/kakao/templates';

function spot(over: Partial<Attraction> = {}): Attraction {
  return {
    name: '오사카성',
    citySlug: 'osaka',
    category: '역사/문화',
    area: '주오구',
    description: '도요토미 히데요시가 지은 성',
    free: false,
    admissionFee: 1200,
    admissionCurrency: 'JPY',
    durationMinutes: 120,
    mapUrl: mapsUrl('오사카성', '오사카'),
    source: 'ai',
    tags: ['야경'],
    ...over,
  };
}

describe('구글맵 링크', () => {
  it('구글이 공개한 검색 URL 규약을 쓴다', () => {
    const url = mapsUrl('오사카성', '오사카');
    expect(url.startsWith('https://www.google.com/maps/search/?api=1&query=')).toBe(true);
  });

  it('도시명을 붙인다 — "중앙공원" 은 전 세계에 있다', () => {
    const url = mapsUrl('중앙공원', '오사카');
    expect(decodeURIComponent(url)).toContain('중앙공원 오사카');
  });

  it('도시명이 없어도 만들어진다', () => {
    expect(decodeURIComponent(mapsUrl('오사카성', null))).toContain('query=오사카성');
  });

  it('한글·공백·기호를 인코딩한다 — 안 하면 링크가 깨진다', () => {
    const url = mapsUrl('유니버설 스튜디오 재팬', '오사카');
    expect(url).not.toContain(' ');
    expect(url).toContain('%');
    // 왕복 변환이 되는지 = 구글이 받는 검색어가 우리가 의도한 그 문자열인지
    expect(decodeURIComponent(url.split('query=')[1])).toBe('유니버설 스튜디오 재팬 오사카');
  });

  it('같은 곳은 항상 같은 URL 이다 — 이게 관광지의 신원이다', () => {
    expect(mapsUrl('오사카성', '오사카')).toBe(mapsUrl(' 오사카성 ', '오사카'));
  });

  it('&, #, ? 가 섞인 이름도 쿼리를 깨뜨리지 않는다', () => {
    const url = mapsUrl('A&B 카페 #1', '도쿄');
    expect(url.match(/\?/g)).toHaveLength(1); // api=1 앞의 물음표 하나뿐
    expect(url).not.toContain('#');
  });
});

describe('관광지 카드 문구', () => {
  describe('입장료', () => {
    it('무료는 무료라고 쓴다', () => {
      expect(admissionText(spot({ free: true, admissionFee: null }))).toBe('무료');
    });

    it('현지 통화 그대로 쓴다 — 환산하면 모델이 틀린 숫자를 만든다', () => {
      expect(admissionText(spot({ admissionFee: 1200, admissionCurrency: 'JPY' }))).toBe(
        '1,200엔',
      );
      expect(admissionText(spot({ admissionFee: 200, admissionCurrency: 'THB' }))).toBe(
        '200바트',
      );
    });

    it('모르는 통화는 코드를 붙인다 — 원화로 바꿔 적지 않는다', () => {
      expect(admissionText(spot({ admissionFee: 25, admissionCurrency: 'MYR' }))).toBe(
        '25 MYR',
      );
    });

    it('통화를 모르면 금액을 버린다 — 숫자만 보이면 원으로 읽힌다', () => {
      // 유료라는 사실은 남기되 "1,200" 은 절대 보여주지 않는다.
      // 엔이었다면 사용자가 10배를 틀리게 읽는다.
      const text = admissionText(spot({ admissionFee: 1200, admissionCurrency: null }));
      expect(text).toBe('유료');
      expect(text).not.toContain('1,200');
    });

    it('유료인 건 아는데 금액을 모르면 "유료" 라도 알려준다', () => {
      expect(admissionText(spot({ free: false, admissionFee: null }))).toBe('유료');
    });

    it('무료인지 유료인지도 모르면 아무 말도 하지 않는다 — 지어내지 않는다', () => {
      expect(admissionText(spot({ free: null, admissionFee: null }))).toBe('');
    });
  });

  describe('listCard 한 줄 (40자)', () => {
    it('입장료 · 소요 · 위치 순으로 넣는다', () => {
      expect(listDescription(spot())).toBe('1,200엔 · 2시간 · 주오구');
    });

    it('무료 관광지', () => {
      expect(listDescription(spot({ free: true, admissionFee: null }))).toBe(
        '무료 · 2시간 · 주오구',
      );
    });

    it('빈 필드는 조용히 빠진다', () => {
      expect(
        listDescription(spot({ free: null, admissionFee: null, durationMinutes: null })),
      ).toBe('주오구');
    });

    it('위치가 없으면 카테고리로 대신한다', () => {
      expect(listDescription(spot({ area: null }))).toBe('1,200엔 · 2시간 · 역사/문화');
    });

    it('전부 없으면 빈 문자열 — listItem 이 description 을 아예 안 넣는다', () => {
      const bare = spot({
        free: null,
        admissionFee: null,
        durationMinutes: null,
        area: null,
        category: null,
      });
      expect(listDescription(bare)).toBe('');
      expect(t.listItem({ title: bare.name, description: listDescription(bare) })).toEqual({
        title: '오사카성',
      });
    });

    it('40자를 넘지 않는다 — 넘으면 카드가 안 보인다', () => {
      const long = spot({ area: '아주아주긴지역이름'.repeat(5), admissionFee: 123456789 });
      const row = t.listItem({ title: long.name, description: listDescription(long) }) as any;
      expect(row.description.length).toBeLessThanOrEqual(t.MAX_LIST_ITEM_DESC);
    });
  });
});

describe('관광지 신원', () => {
  it('이름 표기가 흔들려도 도착지가 같으면 같은 곳이다', () => {
    const a = spot({ name: '오사카성', mapUrl: 'https://maps/x' });
    const b = spot({ name: 'Osaka Castle', mapUrl: 'https://maps/x' });
    expect(attractionKey(a)).toBe(attractionKey(b));
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it('다른 곳은 남는다', () => {
    const a = spot({ mapUrl: 'https://maps/x' });
    const b = spot({ name: '도톤보리', mapUrl: 'https://maps/y' });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it('순서를 지킨다 — 앞에 온 게 더 추천되는 곳이다', () => {
    const first = spot({ name: '첫째', mapUrl: 'https://maps/1' });
    const second = spot({ name: '둘째', mapUrl: 'https://maps/2' });
    expect(dedupe([first, second, first]).map((a) => a.name)).toEqual(['첫째', '둘째']);
  });
});

describe('캐시', () => {

  it('관광지 모양이면 통과', () => {
    expect(isAttraction(spot())).toBe(true);
  });

  it('필드가 빠졌으면 미스로 떨어뜨린다 — 배포로 모양이 바뀔 수 있다', () => {
    expect(isAttraction({ name: '오사카성' })).toBe(false); // mapUrl 없음
    expect(isAttraction({ mapUrl: 'https://maps/x' })).toBe(false); // name 없음
    expect(isAttraction(null)).toBe(false);
    expect(isAttraction('오사카성')).toBe(false);
  });
});

describe('모델 출력 정리 (provider 정규화)', () => {
  describe('이름 — 그대로 지도 검색어가 된다', () => {
    it('슬래시 뒤 부연을 떼어낸다', () => {
      // 실측: 이 이름으로 구글맵을 검색하면 아무것도 안 나온다.
      expect(placeName('오사카 난바 파크스/Namba Parks 쇼핑 & 레저')).toBe('오사카 난바 파크스');
      expect(placeName('오사카 과학관/가족 체험 공간')).toBe('오사카 과학관');
    });

    it('끝의 괄호 설명을 떼어낸다', () => {
      expect(placeName('유니버설 스튜디오 재팬(USJ)')).toBe('유니버설 스튜디오 재팬');
      expect(placeName('도톤보리 （난바）')).toBe('도톤보리');
    });

    it('멀쩡한 이름은 건드리지 않는다', () => {
      expect(placeName('오사카성')).toBe('오사카성');
      expect(placeName('teamLab Botanical Garden')).toBe('teamLab Botanical Garden');
    });

    it('잘라낸 게 전부면 원문을 쓴다 — 이름이 없는 것보단 낫다', () => {
      expect(placeName('(가칭)')).toBe('(가칭)');
    });

    it('이름이 없으면 null — 지도 검색어를 만들 수 없다', () => {
      expect(placeName(null)).toBeNull();
      expect(placeName('  ')).toBeNull();
    });
  });

  describe('위치 — 도시 이름은 정보가 아니다', () => {
    it('앞에 붙은 도시 이름을 떼어낸다', () => {
      expect(area('오사카시 스미노에구', '오사카')).toBe('스미노에구');
      expect(area('오사카 우메다', '오사카')).toBe('우메다');
    });

    it('도시 이름뿐이면 null — 사용자는 이미 그 도시를 물어봤다', () => {
      expect(area('오사카', '오사카')).toBeNull();
      expect(area('오사카시', '오사카')).toBeNull();
    });

    it('관계없는 지명은 그대로 둔다', () => {
      expect(area('난바', '오사카')).toBe('난바');
    });

    it('슬래시 병기는 앞 조각만 — 실측: 방콕에서 "앙깡/시내" 가 나왔다', () => {
      expect(area('앙깡/시내', '방콕')).toBe('앙깡');
      expect(area('우메다/기타구', '오사카')).toBe('우메다');
    });

    it('값이 없으면 null', () => {
      expect(area(null, '오사카')).toBeNull();
      expect(area('  ', '오사카')).toBeNull();
    });
  });
});

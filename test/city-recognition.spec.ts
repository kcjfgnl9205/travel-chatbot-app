import request from 'supertest';

import { findCityInText, lookupCity } from '../src/modules/nlu/city-table';
import {
  ATTRACTIONS,
  FLIGHTS,
  RECOMMEND,
  TestApp,
  createApp,
  kakaoPayload,
} from './helpers';

const textOf = (body: any): string =>
  (body.template?.outputs ?? [])
    .map((o: any) => o.simpleText?.text ?? '')
    .join('\n');

/**
 * 도시 인식 회귀 테스트.
 *
 * 증상은 "도시를 말했는데도 되묻는다" 였다. 원인이 둘이었다.
 *
 *   1. 카카오가 `여행도시` 엔티티로 뽑아준 도시를 서버가 안 읽었다
 *      (영문 파라미터 이름만 보고 있었다).
 *   2. 엔티티가 없을 때의 폴백이 모델 호출 하나뿐이라, 2.5초를 넘기거나
 *      키가 없으면 아는 도시까지 통째로 죽었다.
 *
 * 그래서 이 파일은 **모델을 꺼놓고** 돈다. 모델 없이도 사전에 있는 도시는
 * 전부 살아 있어야 한다.
 */
describe('도시 인식', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createApp();
  });
  afterAll(async () => {
    await t.app.close();
  });
  beforeEach(() => {
    t.openai.enabled = false;
  });
  afterEach(() => {
    t.openai.enabled = true;
  });

  const post = (url: string, payload: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post(url).send(payload);

  describe('제보된 발화 — 전부 "어느 도시…" 로 떨어지던 것들', () => {
    const cases: [string, string][] = [
      [ATTRACTIONS, '세부 여행지 추천해줘'],
      [ATTRACTIONS, '세부여행지 추천'],
      [ATTRACTIONS, '다낭 여행지 추천해줘'],
      [ATTRACTIONS, '프라하 여행지 추천해줘'],
      [ATTRACTIONS, '/여행지검색 하와이'],
      [RECOMMEND, '세부 호텔 추천해줘'],
      [RECOMMEND, '다낭 호텔 추천해줘'],
      [FLIGHTS, '프라하 항공권 추천해줘'],
    ];

    it.each(cases)('%s ← "%s"', async (url, utterance) => {
      const res = await post(url, kakaoPayload(utterance)).expect(201);
      expect(textOf(res.body)).not.toContain('어느 도시');
      expect(t.openai.calls).toHaveLength(0);
    });

    it('도쿄디즈니는 도쿄가 아니다', async () => {
      const res = await post(
        RECOMMEND,
        kakaoPayload('도쿄디즈니 호텔 추천해줘'),
      ).expect(201);
      expect(textOf(res.body)).toContain('도쿄디즈니');
    });

    it('도시가 정말 없으면 지금처럼 되묻는다', async () => {
      const res = await post(ATTRACTIONS, kakaoPayload('여행지 추천해줘')).expect(201);
      expect(textOf(res.body)).toContain('어느 도시');
    });
  });

  describe('여행도시 엔티티', () => {
    /** 카카오가 커스텀 엔티티를 매칭했을 때 실제로 보내는 모양. */
    const withEntity = (utterance: string, city: string) => {
      const payload = kakaoPayload(utterance) as any;
      payload.action.params = { 여행도시: city };
      payload.action.detailParams = {
        여행도시: { origin: city, value: city, groupName: '' },
      };
      return payload;
    };

    it('발화가 기본값이어도 파라미터만으로 검색한다 — 오픈빌더 스킬 테스트가 이 모양이다', async () => {
      const res = await post(
        ATTRACTIONS,
        withEntity('발화 내용', '오사카'),
      ).expect(201);
      expect(textOf(res.body)).toContain('오사카');
      expect(textOf(res.body)).not.toContain('어느 도시');
    });

    it('세 엔드포인트가 같은 파라미터를 읽는다', async () => {
      for (const url of [RECOMMEND, FLIGHTS, ATTRACTIONS]) {
        const res = await post(url, withEntity('발화 내용', '부다페스트')).expect(201);
        expect(textOf(res.body)).toContain('부다페스트');
      }
    });

    it('sys 엔티티가 value 를 JSON 문자열로 줘도 읽는다', async () => {
      const payload = kakaoPayload('여행지 추천해줘') as any;
      payload.action.detailParams = {
        여행도시: { origin: '마카오', value: '{"value":"마카오"}', groupName: '' },
      };
      const res = await post(ATTRACTIONS, payload).expect(201);
      expect(textOf(res.body)).toContain('마카오');
    });
  });
});

describe('도시 사전', () => {
  it('카카오 엔티티에 등록한 237개를 그대로 담는다', async () => {
    // 오픈빌더 엔티티와 같은 목록이어야 한다. 어긋나면 "카카오는 도시로 뽑았는데
    // 서버는 모르는 도시" 상태가 생긴다. 엔티티에 추가하면 여기에도 추가한다.
    const { CITY_TABLE } = await import('../src/modules/nlu/city-table');
    expect(CITY_TABLE).toHaveLength(237);
  });

  it('별칭이 두 도시에 겹치지 않는다', async () => {
    // 겹치면 Map 이 뒤엣것으로 덮어써서 한 도시가 조용히 사라진다.
    const { CITY_TABLE, normalizeAlias } = await import('../src/modules/nlu/city-table');
    const owner = new Map<string, string>();
    for (const city of CITY_TABLE) {
      for (const alias of [city.slug, city.nameKo, ...city.aliases]) {
        const key = normalizeAlias(alias);
        const previous = owner.get(key);
        expect(previous ?? city.slug).toBe(city.slug);
        owner.set(key, city.slug);
      }
    }
  });

  it('새로 등록된 도시들이 실제로 읽힌다', async () => {
    for (const [utterance, slug] of [
      ['레이캬비크 여행지 추천해줘', 'reykjavik'],
      ['시엠립 호텔 추천해줘', 'siem-reap'],
      ['그라나다 관광지 알려줘', 'granada'],
      ['헬싱키 항공권 찾아줘', 'helsinki'],
      ['유후인 온천 숙소', 'yufuin'],
      ['족자카르타 여행지', 'yogyakarta'],
    ] as const) {
      expect(findCityInText(utterance)?.slug).toBe(slug);
    }
  });

  it('⚠️ 도시이면서 흔한 한국어인 말은 문장에서 긁지 않는다', () => {
    // 237개로 늘리면서 들어온 위험들이다. 엔티티로 오면 그대로 쓴다.
    expect(findCityInText('어느 나라 가고 싶어')).toBeNull();
    expect(findCityInText('퍼스트 클래스로 예약')).toBeNull();
    expect(findCityInText('사파리 투어 있어?')).toBeNull();
    // ⚠️ "사파리" 안에는 **파리**도 들어 있다. 최장 일치로는 못 막는다 —
    //    더 긴 별칭이 아예 없기 때문이다. 훑기 전에 말 자체를 지워야 한다.
    expect(findCityInText('테니스 코트 있는 호텔')).toBeNull();
    expect(findCityInText('포르투갈 여행지 추천')).toBeNull(); // 나라지 도시가 아니다
    expect(findCityInText('포르투 여행지 추천')?.slug).toBe('porto');
    expect(findCityInText('파리 여행지 추천')?.slug).toBe('paris');
    expect(lookupCity('나라')?.slug).toBe('nara');
    expect(lookupCity('퍼스')?.slug).toBe('perth');
  });

  it('영문 도시명은 띄어 써도 잡힌다', () => {
    expect(findCityInText('new york 호텔')?.slug).toBe('new-york');
    expect(findCityInText('kuala lumpur 여행지')?.slug).toBe('kuala-lumpur');
  });

  it('표기가 달라도 같은 도시로 모은다', () => {
    expect(lookupCity('동경')?.slug).toBe('tokyo');
    expect(lookupCity('Cebu')?.slug).toBe('cebu');
    expect(lookupCity(' 싱가폴 ')?.nameKo).toBe('싱가포르');
    expect(lookupCity('없는도시')).toBeNull();
  });

  it('전체 일치만 본다 — 문장은 findCityInText 가 맡는다', () => {
    expect(lookupCity('오사카 호텔')).toBeNull();
    expect(findCityInText('오사카 호텔')?.slug).toBe('osaka');
  });

  it('한 글자 도시는 토큰일 때만 인정한다', () => {
    expect(findCityInText('괌에서 묵을 곳')?.slug).toBe('guam');
    expect(findCityInText('관광지 추천해줘')).toBeNull(); // "관" 이 괌이 되면 안 된다
  });

  it('"빈" 은 문장에서 긁지 않는다 — "빈 방" 이 오스트리아가 되면 안 된다', () => {
    expect(findCityInText('빈 방 있는 호텔')).toBeNull();
    expect(findCityInText('비엔나 호텔 추천해줘')?.slug).toBe('vienna');
    // 엔티티로 온 "빈" 은 카카오가 도시로 확정한 값이라 그대로 쓴다.
    expect(lookupCity('빈')?.slug).toBe('vienna');
  });

  it('공항 코드를 들고 있다 — 항공권 검색이 쓴다', () => {
    expect(lookupCity('세부')?.iata).toBe('CEB');
    expect(lookupCity('교토')?.iata).toBe('KIX');
    expect(lookupCity('강릉')?.iata).toBeNull(); // 공항이 없는 도시
  });
});

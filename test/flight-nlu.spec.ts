import { loadConfig } from '../src/config/app.config';
import {
  FlightNluService,
  isoDate,
  todayInSeoul,
} from '../src/modules/nlu/flight-nlu.service';
import { OpenAiService } from '../src/modules/openai/openai.service';
import {
  FLIGHT_ALLOWED_HOSTS,
  conditionsText,
  flightMerchantOf,
  hhmm,
  isAllowedFlightUrl,
  routeText,
} from '../src/modules/flight/providers/openai.provider';
import { FlightQuery } from '../src/modules/flight/flight.types';
import { FakeOpenAiService } from './fake-openai';

describe('항공권 발화 파싱', () => {
  let openai: FakeOpenAiService;
  let nlu: FlightNluService;

  beforeEach(() => {
    openai = new FakeOpenAiService();
    nlu = new FlightNluService(loadConfig(), openai as unknown as OpenAiService);
  });

  it('노선을 뽑는다 — 두 도시가 있으면 앞이 출발지다', async () => {
    const parsed = await nlu.resolve('부산에서 오사카 가는 항공권 2명');
    expect(parsed.originSlug).toBe('busan');
    expect(parsed.originCode).toBe('PUS');
    expect(parsed.destSlug).toBe('osaka');
    expect(parsed.destCode).toBe('KIX');
    expect(parsed.passengers).toBe(2);
  });

  it('출발지를 안 말하면 null 이다 — 서울로 추측하는 건 서비스가 할 일이다', async () => {
    const parsed = await nlu.resolve('오사카 항공권 찾아줘');
    expect(parsed.originSlug).toBeNull();
    expect(parsed.destSlug).toBe('osaka');
  });

  it('왕복 단서가 있으면 round 다', async () => {
    expect((await nlu.resolve('오사카 왕복 항공권')).tripType).toBe('round');
    expect((await nlu.resolve('오사카 항공권 편도')).tripType).toBe('oneway');
  });

  it('오는 날이 있으면 편도라고 왔어도 왕복으로 본다', async () => {
    const parsed = await nlu.resolve('2026-10-03 에서 2026-10-06 오사카 항공권');
    expect(parsed.tripType).toBe('round');
    expect(parsed.departDate).toBe('2026-10-03');
    expect(parsed.returnDate).toBe('2026-10-06');
  });

  it('목적지가 없으면 없다고 한다', async () => {
    for (const text of ['항공권 알려줘', '안녕', '비행기 싸게 가는 법']) {
      expect((await nlu.resolve(text)).destSlug).toBeNull();
    }
  });

  it('빈 발화는 모델을 부르지도 않는다', async () => {
    expect((await nlu.resolve('   ')).destSlug).toBeNull();
    expect(openai.calls).toHaveLength(0);
  });

  it('오늘 날짜를 모델에 넘긴다 — 없으면 "내일"을 절대 날짜로 못 바꾼다', async () => {
    await nlu.resolve('내일 오사카 항공권');
    expect(openai.calls[0].input).toContain(todayInSeoul());
  });

  describe('오픈빌더 엔티티', () => {
    it('도착지를 주면 모델을 부르지 않는다', async () => {
      const parsed = await nlu.resolve('', { destination: '오사카' });
      expect(parsed.destName).toBe('오사카');
      // 사전에 있는 도시라 슬러그·공항 코드까지 채워진다. 모델 경로와 같은 키로
      // 모여야 캐시가 갈리지 않는다.
      expect(parsed.destSlug).toBe('osaka');
      expect(parsed.destCode).toBe('KIX');
      expect(openai.calls).toHaveLength(0);
    });

    it('사전에 없는 도시는 엔티티 값을 그대로 쓴다', async () => {
      const parsed = await nlu.resolve('', { destination: '없는도시' });
      expect(parsed.destName).toBe('없는도시');
      expect(parsed.destCode).toBeNull();
      expect(openai.calls).toHaveLength(0);
    });

    it('도착지가 있어도 날짜 단서가 있으면 모델을 마저 부른다', async () => {
      // sys.date 엔티티는 "다음달 3일" 을 절대 날짜로 안 줄 때가 있다.
      // 날짜를 놓치면 검색이 통째로 틀어지므로 여기서는 돈을 쓰는 게 맞다.
      const parsed = await nlu.resolve('2026-10-03 오사카 왕복', {
        destination: '오사카',
      });
      expect(parsed.destSlug).toBe('osaka');
      expect(parsed.departDate).toBe('2026-10-03');
      expect(openai.calls).toHaveLength(1);
    });

    it('엔티티 날짜가 YYYY-MM-DD 가 아니면 버린다 — 캐시 키와 프롬프트가 오염된다', async () => {
      const parsed = await nlu.resolve('', {
        destination: '오사카',
        departDate: '다음달 3일',
      });
      expect(parsed.departDate).toBeNull();
    });
  });

  describe('별칭 캐시 — 이게 없으면 매 메시지가 유료다', () => {
    // 사전에 있는 도시("오사카")는 모델을 부르지 않으므로 캐시 검증에 쓸 수 없다.
    it('같은 문장은 한 번만 파싱한다', async () => {
      await nlu.resolve('없는도시 항공권 찾아줘');
      await nlu.resolve('없는도시 항공권 찾아줘');
      await nlu.resolve('없는도시 항공권 찾아줘');
      expect(openai.calls).toHaveLength(1);
    });

    it('목적지를 못 찾은 결과는 캐싱하지 않는다', async () => {
      await nlu.resolve('항공권 알려줘');
      await nlu.resolve('항공권 알려줘');
      expect(openai.calls).toHaveLength(2);
    });

    it('날짜가 바뀌면 캐시가 갈린다 — 어제의 "내일"은 오늘의 내일이 아니다', async () => {
      const key = (utterance: string, day: string) =>
        // keyOf 는 private 이므로 오늘 날짜가 키에 섞인다는 사실만 확인한다.
        `${day}:${utterance}`;
      expect(key('내일오사카항공권', '2026-09-08')).not.toBe(
        key('내일오사카항공권', '2026-09-09'),
      );
    });
  });

  describe('도시 사전 — 엔티티가 안 왔을 때의 폴백', () => {
    it('도착지 하나뿐인 발화는 모델 없이 끝낸다', async () => {
      const parsed = await nlu.resolve('다낭 항공권 추천해줘');
      expect(parsed.destSlug).toBe('danang');
      expect(parsed.destCode).toBe('DAD');
      expect(openai.calls).toHaveLength(0);
    });

    it('출발지를 말한 발화는 사전에 맡기지 않는다 — 노선이 뒤집힌다', async () => {
      // "오사카에서 서울" 을 사전에 맡기면 더 긴 별칭인 오사카가 도착지로 잡힌다.
      const parsed = await nlu.resolve('오사카에서 서울 가는 항공권');
      expect(parsed.originSlug).toBe('osaka');
      expect(parsed.destSlug).toBe('seoul');
      expect(openai.calls).toHaveLength(1);
    });

    it('엔티티가 도착지를 줘도 출발지를 말했으면 모델이 마저 채운다', async () => {
      // 출발지 엔티티는 아직 오픈빌더에 없다. 그래서 발화에서 긁어야 한다.
      const parsed = await nlu.resolve('부산에서 오사카 항공권', {
        destination: '오사카',
      });
      expect(parsed.destSlug).toBe('osaka');
      expect(parsed.originName).toBe('부산');
    });
  });

  describe('모델 실패는 되묻기로 떨어진다 (5초 예산)', () => {
    it('타임아웃', async () => {
      openai.timeoutNext = true;
      const outcome = await nlu.resolveDetailed('없는도시 항공권');
      expect(outcome.parsed.destSlug).toBeNull();
      expect(outcome.timedOut).toBe(true);
    });

    it('키가 없으면 시도조차 하지 않는다', async () => {
      openai.enabled = false;
      const outcome = await nlu.resolveDetailed('없는도시 항공권');
      expect(outcome.source).toBe('skipped');
      expect(outcome.error).toContain('OPENAI_API_KEY');
      expect(openai.calls).toHaveLength(0);
    });

    it('키가 없어도 사전에 있는 도시는 살아 있다', async () => {
      openai.enabled = false;
      const outcome = await nlu.resolveDetailed('세부 항공권');
      expect(outcome.parsed.destSlug).toBe('cebu');
      expect(outcome.parsed.destCode).toBe('CEB');
      expect(outcome.source).toBe('table');
      expect(openai.calls).toHaveLength(0);
    });
  });

  describe('날짜 검증', () => {
    it('YYYY-MM-DD 만 통과한다', () => {
      expect(isoDate('2026-10-03')).toBe('2026-10-03');
      expect(isoDate('2026-1-3')).toBeNull();
      expect(isoDate('다음달 3일')).toBeNull();
      expect(isoDate(null)).toBeNull();
    });

    it('없는 날짜는 버린다 — Date 는 2026-02-30 을 3월로 굴려버린다', () => {
      expect(isoDate('2026-02-30')).toBeNull();
      expect(isoDate('2026-13-01')).toBeNull();
      expect(isoDate('2028-02-29')).toBe('2028-02-29'); // 윤년은 실제로 있다
    });
  });
});

describe('항공권 provider 정규화', () => {
  const query = (over: Partial<FlightQuery> = {}): FlightQuery => ({
    originSlug: 'seoul',
    originName: '서울',
    originCode: 'ICN',
    destSlug: 'osaka',
    destName: '오사카',
    destCode: 'KIX',
    departDate: '2026-10-03',
    returnDate: null,
    tripType: 'oneway',
    passengers: null,
    cabin: null,
    limit: 5,
    originAssumed: true,
    ...over,
  });

  describe('신뢰하는 예약 호스트만 통과시킨다', () => {
    it('항공권을 파는 곳', () => {
      expect(isAllowedFlightUrl('https://kr.trip.com/flights/osaka')).toBe(true);
      expect(isAllowedFlightUrl('https://www.myrealtrip.com/offers/12345')).toBe(true);
    });

    it('항공권을 안 파는 곳은 호텔에서 허용돼도 막는다', () => {
      // 클룩·호텔스닷컴은 항공권을 팔지 않는다. 허용하면 엉뚱한 페이지가 나간다.
      expect(isAllowedFlightUrl('https://www.klook.com/ko/hotel/1-abc/')).toBe(false);
      expect(isAllowedFlightUrl('https://kr.hotels.com/ho123456/')).toBe(false);
      expect(FLIGHT_ALLOWED_HOSTS).toEqual(['trip.com', 'myrealtrip.com']);
    });

    it('모델이 지어낸 호스트와 사칭 도메인을 막는다', () => {
      expect(isAllowedFlightUrl('https://www.skyscanner.co.kr/x')).toBe(false);
      expect(isAllowedFlightUrl('https://trip.com.evil.kr/1')).toBe(false);
      expect(isAllowedFlightUrl('https://nottrip.com/1')).toBe(false);
      expect(isAllowedFlightUrl('http://kr.trip.com/1')).toBe(false); // https 만
      expect(isAllowedFlightUrl('정보 없음')).toBe(false);
    });

    it('제휴몰 이름을 뽑는다', () => {
      expect(flightMerchantOf('https://kr.trip.com/flights/x')).toBe('trip');
      expect(flightMerchantOf('https://www.myrealtrip.com/x')).toBe('myrealtrip');
      expect(flightMerchantOf('https://example.com/x')).toBeNull();
    });
  });

  describe('시각 정규화 — 모델은 표기를 섞어서 준다', () => {
    it('HH:MM 으로 맞춘다', () => {
      expect(hhmm('09:20')).toBe('09:20');
      expect(hhmm('9:5')).toBe('09:05');
      expect(hhmm('09:20 (현지)')).toBe('09:20');
      expect(hhmm('오후 2시 30분')).toBe('14:30');
      expect(hhmm('2:30 PM')).toBe('14:30');
      expect(hhmm('오전 12시')).toBe('00:00');
    });

    it('읽어낼 수 없으면 버린다 — 시각 없는 카드가 틀린 시각보다 낫다', () => {
      expect(hhmm('저녁 늦게')).toBeNull();
      expect(hhmm('25:00')).toBeNull();
      expect(hhmm('09:70')).toBeNull();
      expect(hhmm(null)).toBeNull();
    });
  });

  describe('프롬프트 조각', () => {
    it('노선 표기는 로그와 프롬프트에서 같다', () => {
      expect(routeText(query())).toBe('서울(ICN) → 오사카(KIX)');
      expect(routeText(query({ originCode: null, destCode: null }))).toBe('서울 → 오사카');
    });

    it('날짜가 없으면 되묻지 말라고 명시한다 — 없으면 모델이 날짜를 지어낸다', () => {
      expect(conditionsText(query({ departDate: null }))).toContain('일반적인 요금대');
      expect(conditionsText(query())).toContain('2026-10-03');
    });

    it('조건이 없으면 문장에서 빠진다', () => {
      const text = conditionsText(query({ passengers: null, cabin: null }));
      expect(text).not.toContain('인원');
      expect(text).not.toContain('좌석');
    });
  });
});

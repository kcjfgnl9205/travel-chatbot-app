import { loadConfig } from '../src/config/app.config';
import { NluService } from '../src/modules/nlu/nlu.service';
import { OpenAiService } from '../src/modules/openai/openai.service';
import { findCityInText } from '../src/modules/nlu/city-table';
import { citySlugOf, utteranceKeyOf } from '../src/modules/nlu/nlu';
import { FakeOpenAiService } from './fake-openai';

describe('발화 파싱', () => {
  let openai: FakeOpenAiService;
  let nlu: NluService;

  beforeEach(() => {
    openai = new FakeOpenAiService();
    nlu = new NluService(loadConfig(), openai as unknown as OpenAiService);
  });

  describe('자연어 문장에서 도시와 조건을 뽑는다', () => {
    it('실제 카카오 사용자가 쓰는 문장', async () => {
      const parsed = await nlu.resolve(
        '오사카 여행갈건데 4명기준으로 숙소 추천해줘',
      );
      expect(parsed.citySlug).toBe('osaka');
      expect(parsed.cityName).toBe('오사카');
      expect(parsed.guests).toBe(4);
    });

    it('오타를 교정한다 — 키워드 매칭으로는 못 하던 것', async () => {
      expect((await nlu.resolve('오사카 호텔 추천')).citySlug).toBe('osaka');
      expect((await nlu.resolve('오오사카 숙소')).citySlug).toBe('osaka');
    });

    it('다른 표기도 같은 슬러그로 모은다 — 캐시가 갈리면 안 된다', async () => {
      const a = await nlu.resolve('동경 호텔 추천해줘');
      const b = await nlu.resolve('도쿄 숙소 알려줘');
      expect(a.citySlug).toBe(b.citySlug);
      expect(a.cityName).toBe('도쿄');
    });

    it('모르는 도시도 그대로 받는다 — 화이트리스트가 없다', async () => {
      const parsed = await nlu.resolve('방콕 3박 2명 숙소 찾아줘');
      expect(parsed.citySlug).toBe('bangkok');
      expect(parsed.guests).toBe(2);
      expect(parsed.nights).toBe(3);
    });

    it('도시가 없으면 없다고 한다', async () => {
      for (const text of ['호텔 추천해줘', '안녕', '뭐 좋은 숙소 없을까']) {
        expect((await nlu.resolve(text)).citySlug).toBeNull();
      }
    });

    it('빈 발화는 모델을 부르지도 않는다', async () => {
      expect((await nlu.resolve('   ')).citySlug).toBeNull();
      expect(openai.calls).toHaveLength(0);
    });
  });

  // 사전에 있는 도시("오사카")는 모델을 부르지 않으므로 캐시 검증에 쓸 수 없다.
  // 여기서는 사전에 없는 도시를 써서 모델 경로를 실제로 지나게 한다.
  describe('별칭 캐시 — 이게 없으면 매 메시지가 유료다', () => {
    it('같은 문장은 한 번만 파싱한다', async () => {
      await nlu.resolve('없는도시 호텔 추천해줘');
      await nlu.resolve('없는도시 호텔 추천해줘');
      await nlu.resolve('없는도시 호텔 추천해줘');
      expect(openai.calls).toHaveLength(1);
    });

    it('띄어쓰기·문장부호만 다른 문장도 같은 것으로 본다', async () => {
      await nlu.resolve('없는도시 호텔 추천해줘');
      await nlu.resolve('없는도시호텔 추천해줘!!');
      expect(openai.calls).toHaveLength(1);
    });

    it('다른 문장은 새로 파싱한다', async () => {
      await nlu.resolve('없는도시 호텔 추천해줘');
      await nlu.resolve('asdf 호텔 추천해줘');
      expect(openai.calls).toHaveLength(2);
    });

    it('도시를 못 찾은 결과는 캐싱하지 않는다 — 일시적 실패를 굳히면 안 된다', async () => {
      await nlu.resolve('호텔 추천해줘');
      await nlu.resolve('호텔 추천해줘');
      expect(openai.calls).toHaveLength(2);
    });

    it('peek 은 공짜 경로만 본다 — 모델을 부르지 않는다', async () => {
      // 사전에 있는 도시는 캐시가 비어 있어도 peek 이 바로 안다 (0원).
      expect(nlu.peek('오사카 호텔 추천해줘').citySlug).toBe('osaka');
      // 사전에 없는 도시는 파싱 전까지 모른다. 그래도 모델을 부르지는 않는다.
      expect(nlu.peek('없는도시 호텔 추천해줘').citySlug).toBeNull();
      expect(openai.calls).toHaveLength(0);

      await nlu.resolve('없는도시 호텔 추천해줘');
      expect(nlu.peek('없는도시 호텔 추천해줘').citySlug).toBe('nowhere');
      expect(openai.calls).toHaveLength(1);
    });
  });

  describe('5초 예산을 지킨다', () => {
    it('파싱이 실패하면 도시 미상으로 넘긴다 — 예외를 던지지 않는다', async () => {
      openai.failNext = true;
      const parsed = await nlu.resolve('없는도시 호텔 추천해줘');
      expect(parsed.citySlug).toBeNull();
    });

    it('실패 원인을 뭉개지 않는다 — "도시 없음"과 "타임아웃"은 다른 문제다', async () => {
      // 이걸 뭉개면 진단 엔드포인트가 타임아웃을 "도시를 못 뽑았습니다" 로 보고한다.
      openai.failNext = true;
      const failed = await nlu.resolveDetailed('없는도시 호텔 추천해줘');
      expect(failed.parsed.citySlug).toBeNull();
      expect(failed.error).toContain('openai unavailable');
      expect(failed.source).toBe('model');

      // 모델이 정상 응답했는데 도시가 없는 경우는 error 가 null 이어야 한다
      const noCity = await nlu.resolveDetailed('안녕');
      expect(noCity.parsed.citySlug).toBeNull();
      expect(noCity.error).toBeNull();
    });

    it('타임아웃은 timedOut 으로 구분된다', async () => {
      openai.timeoutNext = true;
      const outcome = await nlu.resolveDetailed('없는도시 호텔 추천해줘');
      expect(outcome.timedOut).toBe(true);
      expect(outcome.error).toContain('timeout');
    });

    it('어디서 온 답인지 알려준다', async () => {
      expect((await nlu.resolveDetailed('호텔 추천', '프라하')).source).toBe(
        'entity',
      );
      expect((await nlu.resolveDetailed('오사카 호텔')).source).toBe('table');
      expect((await nlu.resolveDetailed('없는도시 호텔')).source).toBe('model');
      expect((await nlu.resolveDetailed('없는도시 호텔')).source).toBe('cache');
    });

    it('fresh 는 캐시를 읽지도 쓰지도 않는다 — 진단이 운영 캐시를 데우면 안 된다', async () => {
      await nlu.resolveDetailed('없는도시 호텔', null, { fresh: true });
      expect(nlu.peek('없는도시 호텔').citySlug).toBeNull();

      await nlu.resolve('없는도시 호텔');
      const again = await nlu.resolveDetailed('없는도시 호텔', null, {
        fresh: true,
      });
      expect(again.source).toBe('model'); // 캐시가 있어도 무시하고 다시 부른다
    });

    it('파싱은 검색과 다른 모델을 쓸 수 있다 — 속도가 곧 품질인 자리다', async () => {
      await nlu.resolve('없는도시 호텔 추천해줘');
      expect(openai.calls[0].model).toBe(loadConfig().openaiParseModel);
    });

    it('키가 없으면 모델을 부르지 않는다', async () => {
      openai.enabled = false;
      expect((await nlu.resolve('없는도시 호텔 추천해줘')).citySlug).toBeNull();
      expect(openai.calls).toHaveLength(0);
    });

    it('키가 없어도 사전에 있는 도시는 살아 있다', async () => {
      // 파싱을 통째로 모델에 맡기던 때는 키가 없으면 모든 도시가 죽었다.
      openai.enabled = false;
      expect((await nlu.resolve('세부 호텔 추천해줘')).citySlug).toBe('cebu');
      expect(openai.calls).toHaveLength(0);
    });

    it('파싱 호출에는 짧은 타임아웃이 붙는다 (검색용 60초와 달라야 한다)', async () => {
      await nlu.resolve('없는도시 호텔 추천해줘');
      const req = openai.calls[0];
      expect(req.timeoutMs).toBeLessThanOrEqual(5000);
      expect(req.tools).toBeUndefined(); // 웹 검색을 붙이면 느려진다
      expect(req.effort).toBe('minimal');
    });
  });

  describe('오픈빌더 엔티티', () => {
    it('엔티티가 오면 모델을 부르지 않는다 — 이미 도시다', async () => {
      const parsed = await nlu.resolve('호텔 추천해줘', '후쿠오카');
      expect(parsed.cityName).toBe('후쿠오카');
      expect(parsed.citySlug).toBe('fukuoka');
      expect(openai.calls).toHaveLength(0);
    });

    it('사전에 없는 도시여도 그대로 쓴다', async () => {
      expect((await nlu.resolve('호텔 추천해줘', '없는도시')).cityName).toBe(
        '없는도시',
      );
      expect(openai.calls).toHaveLength(0);
    });

    it('엔티티 표기를 대표 이름으로 통일한다', async () => {
      // 엔티티가 원문을 그대로 주더라도 캐시 키가 갈리면 안 된다.
      const parsed = await nlu.resolve('호텔 추천해줘', '동경');
      expect(parsed.cityName).toBe('도쿄');
      expect(parsed.citySlug).toBe('tokyo');
    });

    it('발화가 비어 있어도 엔티티만으로 답한다 — 스킬 테스트가 이 모양이다', async () => {
      // 오픈빌더 스킬 테스트는 utterance 를 "발화 내용" 으로 두고 파라미터만 채운다.
      const parsed = await nlu.resolve('발화 내용', '세부');
      expect(parsed.citySlug).toBe('cebu');
    });
  });

  describe('도시 사전 — 엔티티가 안 왔을 때의 폴백', () => {
    it('사전에 있는 도시는 모델 없이 즉시 잡는다', async () => {
      for (const [utterance, slug] of [
        ['세부 여행지 추천해줘', 'cebu'],
        ['세부여행지 추천', 'cebu'],
        ['다낭 호텔 추천해줘', 'danang'],
        ['프라하 관광지 알려줘', 'prague'],
        ['하와이 숙소', 'hawaii'],
        ['코타키나발루 호텔', 'kota-kinabalu'],
      ] as const) {
        expect((await nlu.resolve(utterance)).citySlug).toBe(slug);
      }
      expect(openai.calls).toHaveLength(0);
    });

    it('가장 긴 별칭이 이긴다 — 도쿄디즈니가 도쿄로 잡히면 안 된다', async () => {
      expect((await nlu.resolve('도쿄디즈니 호텔 추천해줘')).citySlug).toBe(
        'tokyo-disney',
      );
      expect((await nlu.resolve('도쿄 호텔 추천해줘')).citySlug).toBe('tokyo');
    });

    it('"세부 사항" 은 사전이 도시로 보지 않는다', async () => {
      // 모델까지 가면 FakeOpenAiService 가 표 매칭으로 세부를 잡는다(진짜 모델은
      // 안 그런다). 여기서 보려는 건 사전이 일반 명사를 거르는가다.
      expect(findCityInText('예약 세부 사항 알려줘')).toBeNull();
      expect(findCityInText('세부 일정 짜줘')?.slug).toBeUndefined();
      expect(findCityInText('세부 호텔 추천해줘')?.slug).toBe('cebu');
    });

    it('도시가 둘이면 사전이 고르지 않는다 — 모델에 넘긴다', async () => {
      // 같은 길이로 둘이 걸리면 어느 쪽이 목적지인지 사전은 모른다.
      await nlu.resolve('서울에서 세부 가는 길에 호텔');
      expect(openai.calls).toHaveLength(1);
    });

    it('인원·박수가 섞이면 사전으로 끝내지 않고 모델을 마저 부른다', async () => {
      const parsed = await nlu.resolve('세부 호텔 4명 3박');
      expect(parsed.citySlug).toBe('cebu'); // 도시는 사전이 정한다
      expect(parsed.guests).toBe(4);
      expect(parsed.nights).toBe(3);
      expect(openai.calls).toHaveLength(1);
    });

    it('cityOnly 는 숫자가 있어도 모델을 부르지 않는다 — 관광지가 쓴다', async () => {
      const parsed = await nlu.resolve('세부 관광지 5곳 추천해줘', null, {
        cityOnly: true,
      });
      expect(parsed.citySlug).toBe('cebu');
      expect(openai.calls).toHaveLength(0);
    });
  });
});

describe('키 정규화', () => {
  it('도시 슬러그는 소문자·하이픈으로 모은다', () => {
    expect(citySlugOf('New York')).toBe('new-york');
    expect(citySlugOf(' Osaka ')).toBe('osaka');
  });

  it('사전에 있는 도시는 표기가 뭐든 같은 슬러그로 모인다', () => {
    // 이게 없으면 엔티티 경로('방콕')와 모델 경로('bangkok')가 다른 캐시를 쓴다.
    expect(citySlugOf('방콕')).toBe('bangkok');
    expect(citySlugOf('동경')).toBe('tokyo');
    expect(citySlugOf('Cebu')).toBe('cebu');
  });

  it('발화 키는 띄어쓰기·문장부호를 무시한다', () => {
    expect(utteranceKeyOf('오사카 호텔 추천해줘!')).toBe(
      utteranceKeyOf('오사카호텔추천해줘'),
    );
    expect(utteranceKeyOf('Osaka Hotel')).toBe('osakahotel');
  });
});

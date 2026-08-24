import { loadConfig } from '../src/config/app.config';
import { NluService } from '../src/modules/nlu/nlu.service';
import { OpenAiService } from '../src/modules/openai/openai.service';
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

  describe('별칭 캐시 — 이게 없으면 매 메시지가 유료다', () => {
    it('같은 문장은 한 번만 파싱한다', async () => {
      await nlu.resolve('오사카 호텔 추천해줘');
      await nlu.resolve('오사카 호텔 추천해줘');
      await nlu.resolve('오사카 호텔 추천해줘');
      expect(openai.calls).toHaveLength(1);
    });

    it('띄어쓰기·문장부호만 다른 문장도 같은 것으로 본다', async () => {
      await nlu.resolve('오사카 호텔 추천해줘');
      await nlu.resolve('오사카호텔 추천해줘!!');
      expect(openai.calls).toHaveLength(1);
    });

    it('다른 문장은 새로 파싱한다', async () => {
      await nlu.resolve('오사카 호텔 추천해줘');
      await nlu.resolve('도쿄 호텔 추천해줘');
      expect(openai.calls).toHaveLength(2);
    });

    it('도시를 못 찾은 결과는 캐싱하지 않는다 — 일시적 실패를 굳히면 안 된다', async () => {
      await nlu.resolve('호텔 추천해줘');
      await nlu.resolve('호텔 추천해줘');
      expect(openai.calls).toHaveLength(2);
    });

    it('peek 은 캐시만 본다 — 모델을 부르지 않는다', async () => {
      expect(nlu.peek('오사카 호텔 추천해줘').citySlug).toBeNull();
      expect(openai.calls).toHaveLength(0);

      await nlu.resolve('오사카 호텔 추천해줘');
      expect(nlu.peek('오사카 호텔 추천해줘').citySlug).toBe('osaka');
      expect(openai.calls).toHaveLength(1);
    });
  });

  describe('5초 예산을 지킨다', () => {
    it('파싱이 실패하면 도시 미상으로 넘긴다 — 예외를 던지지 않는다', async () => {
      openai.failNext = true;
      const parsed = await nlu.resolve('오사카 호텔 추천해줘');
      expect(parsed.citySlug).toBeNull();
    });

    it('실패 원인을 뭉개지 않는다 — "도시 없음"과 "타임아웃"은 다른 문제다', async () => {
      // 이걸 뭉개면 진단 엔드포인트가 타임아웃을 "도시를 못 뽑았습니다" 로 보고한다.
      openai.failNext = true;
      const failed = await nlu.resolveDetailed('오사카 호텔 추천해줘');
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
      const outcome = await nlu.resolveDetailed('오사카 호텔 추천해줘');
      expect(outcome.timedOut).toBe(true);
      expect(outcome.error).toContain('timeout');
    });

    it('어디서 온 답인지 알려준다', async () => {
      expect((await nlu.resolveDetailed('호텔 추천', '프라하')).source).toBe(
        'entity',
      );
      expect((await nlu.resolveDetailed('오사카 호텔')).source).toBe('model');
      expect((await nlu.resolveDetailed('오사카 호텔')).source).toBe('cache');
    });

    it('fresh 는 캐시를 읽지도 쓰지도 않는다 — 진단이 운영 캐시를 데우면 안 된다', async () => {
      await nlu.resolveDetailed('오사카 호텔', null, { fresh: true });
      expect(nlu.peek('오사카 호텔').citySlug).toBeNull();

      await nlu.resolve('오사카 호텔');
      const again = await nlu.resolveDetailed('오사카 호텔', null, {
        fresh: true,
      });
      expect(again.source).toBe('model'); // 캐시가 있어도 무시하고 다시 부른다
    });

    it('파싱은 검색과 다른 모델을 쓸 수 있다 — 속도가 곧 품질인 자리다', async () => {
      await nlu.resolve('오사카 호텔 추천해줘');
      expect(openai.calls[0].model).toBe(loadConfig().openaiParseModel);
    });

    it('키가 없으면 모델을 부르지 않는다', async () => {
      openai.enabled = false;
      expect((await nlu.resolve('오사카 호텔 추천해줘')).citySlug).toBeNull();
      expect(openai.calls).toHaveLength(0);
    });

    it('파싱 호출에는 짧은 타임아웃이 붙는다 (검색용 60초와 달라야 한다)', async () => {
      await nlu.resolve('오사카 호텔 추천해줘');
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
      expect(parsed.citySlug).toBe('후쿠오카');
      expect(openai.calls).toHaveLength(0);
    });

    it('모르는 도시여도 그대로 쓴다', async () => {
      expect((await nlu.resolve('호텔 추천해줘', '프라하')).cityName).toBe(
        '프라하',
      );
    });
  });
});

describe('키 정규화', () => {
  it('도시 슬러그는 소문자·하이픈으로 모은다', () => {
    expect(citySlugOf('New York')).toBe('new-york');
    expect(citySlugOf(' Osaka ')).toBe('osaka');
    expect(citySlugOf('방콕')).toBe('방콕');
  });

  it('발화 키는 띄어쓰기·문장부호를 무시한다', () => {
    expect(utteranceKeyOf('오사카 호텔 추천해줘!')).toBe(
      utteranceKeyOf('오사카호텔추천해줘'),
    );
    expect(utteranceKeyOf('Osaka Hotel')).toBe('osakahotel');
  });
});

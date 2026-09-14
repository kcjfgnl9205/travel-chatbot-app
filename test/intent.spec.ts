import { Test } from '@nestjs/testing';

import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/modules/database/database.module';
import { IntentModule } from '../src/modules/intent/intent.module';
import { IntentService, fromKeywords } from '../src/modules/intent/intent.service';
import {
  TRAVEL_HINT,
  fromCommand,
  ignoredConditions,
  intentFromKeywords,
  mergeIgnored,
  tripTypeOf,
} from '../src/modules/intent/intent.types';
import { withObjectParticle } from '../src/modules/kakao/cards';
import { OpenAiService } from '../src/modules/openai/openai.service';
import { FakeOpenAiService } from './fake-openai';

describe('1차 필터 (TRAVEL_HINT)', () => {
  it.each([
    '오사카 호텔 추천해줘',
    '도쿄 항공권 얼마야',
    '후쿠오카 맛집 알려줘',
    '오사카 가볼만한 곳',
  ])('여행 발화를 통과시킨다: %s', (utterance) => {
    expect(TRAVEL_HINT.test(utterance)).toBe(true);
  });

  it.each(['안녕하세요', '다들 뭐해?', 'ㅋㅋㅋ 진짜?', '오늘 회의 몇시야'])(
    '잡담은 여기서 끊는다 (모델 호출 0회): %s',
    (utterance) => {
      expect(TRAVEL_HINT.test(utterance)).toBe(false);
    },
  );
});

describe('키워드 해석', () => {
  it('의도를 키워드로 가른다', () => {
    expect(intentFromKeywords('오사카 호텔')).toBe('hotel');
    expect(intentFromKeywords('오사카 항공권')).toBe('flight');
    expect(intentFromKeywords('오사카 관광지')).toBe('attraction');
    expect(intentFromKeywords('오사카 날씨')).toBe('unknown');
  });

  it('기본은 왕복이다 — 항공권 질문의 대부분이 왕복이다', () => {
    expect(tripTypeOf('오사카 항공권')).toBe('rt');
    expect(tripTypeOf('오사카 왕복 항공권')).toBe('rt');
    expect(tripTypeOf('오사카 편도 항공권')).toBe('ow');
    expect(tripTypeOf('오사카 가는 편만')).toBe('ow');
  });

  it('사전에 있는 도시 + 키워드면 모델 없이 끝난다', () => {
    const parsed = fromKeywords('오사카 호텔 4명 추천해줘');

    expect(parsed).toMatchObject({ intent: 'hotel', place: '오사카', from: null });
    expect(parsed?.ignored).toContain('4명');
  });

  it('지명이 둘이면 모델에 넘긴다 — 어느 쪽이 목적지인지 사전으로는 못 가린다', () => {
    expect(fromKeywords('부산에서 오사카 항공권')).toBeNull();
  });

  it('사전에 없는 지명도 모델에 넘긴다', () => {
    expect(fromKeywords('도톤보리 호텔')).toBeNull();
  });

  it('리조트도 숙소로 본다', () => {
    expect(intentFromKeywords('오사카 리조트')).toBe('hotel');
    expect(TRAVEL_HINT.test('오사카 리조트 추천')).toBe(true);
  });
});

describe('대표 명령어 (/호텔 · /항공권 · /여행지)', () => {
  it('명령어 뒤의 한 단어는 지명이다 — 사전에 없어도 모델을 안 부른다', () => {
    expect(fromCommand('여행지 도톤보리')).toMatchObject({
      intent: 'attraction',
      place: '도톤보리',
    });
    expect(fromCommand('호텔 오사카')).toMatchObject({ intent: 'hotel', place: '오사카' });
    expect(fromCommand('항공권 후쿠오카')).toMatchObject({ intent: 'flight', place: '후쿠오카' });
  });

  it('슬래시를 붙여 쳐도 같다 — 메뉴에서 고르면 슬래시가 없지만 직접 치기도 한다', () => {
    expect(fromCommand('/여행지 오사카')).toMatchObject({ intent: 'attraction', place: '오사카' });
    expect(fromCommand('/호텔 오사카')).toMatchObject({ intent: 'hotel', place: '오사카' });
    expect(fromCommand('/항공권 오사카')).toMatchObject({ intent: 'flight', place: '오사카' });
    expect(fromCommand('/여행지 도톤보리')).toMatchObject({
      intent: 'attraction',
      place: '도톤보리',
    });
  });

  it('⚠️ 서술어를 지명으로 등록하지 않는다', () => {
    // 이걸 통과시키면 places 테이블에 "추천해줘" 가 지역으로 박힌다.
    expect(fromCommand('호텔 추천해줘')).toBeNull();
    expect(fromCommand('항공권 알려줘')).toBeNull();
    expect(fromCommand('여행지 어디')).toBeNull();
  });

  it('여러 단어면 모델에 넘긴다 — 지명인지 문장인지 여기선 못 가린다', () => {
    expect(fromCommand('호텔 예약 어떻게 해?')).toBeNull();
    expect(fromCommand('여행지 오사카 추천해줘')).toBeNull();
  });

  it('명령어만 보내면 지명이 없다 → 되묻기로 간다', () => {
    expect(fromCommand('여행지')).toBeNull();
  });
});

describe('무시한 조건 추출', () => {
  it('날짜·인원·예산을 사용자가 쓴 그대로 담는다', () => {
    const found = ignoredConditions('오사카 호텔 4명 9월 22일~24일 2박 30만원대');

    expect(found).toEqual(expect.arrayContaining(['4명', '2박', '30만원대']));
    expect(found.some((c) => c.includes('9월'))).toBe(true);
  });

  it('"인천" 을 인원으로 읽지 않는다', () => {
    expect(ignoredConditions('인천에서 오사카 항공권')).toEqual([]);
  });

  it('같은 조건은 한 번만 남는다', () => {
    expect(mergeIgnored(['4명', '4 명'], ['4명', '2박'])).toEqual(['4명', '2박']);
  });
});

describe('IntentService', () => {
  let service: IntentService;
  let openai: FakeOpenAiService;

  beforeEach(async () => {
    openai = new FakeOpenAiService();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, IntentModule],
    })
      .overrideProvider(OpenAiService)
      .useValue(openai)
      .compile();

    service = moduleRef.get(IntentService);
    service.clearMemory();
  });

  it('사전으로 끝나는 발화에는 모델을 부르지 않는다', async () => {
    const parsed = await service.extract('오사카 호텔 추천해줘');

    expect(parsed).toMatchObject({ intent: 'hotel', place: '오사카' });
    expect(openai.calls).toHaveLength(0);
  });

  it('대표 명령어는 사전에 없는 지명도 모델 없이 끝낸다', async () => {
    const parsed = await service.extract('여행지 도톤보리');

    expect(parsed).toMatchObject({ intent: 'attraction', place: '도톤보리' });
    expect(openai.calls).toHaveLength(0);
  });

  it('출발지가 섞이면 모델이 해석한다', async () => {
    const parsed = await service.extract('부산에서 오사카 가는 항공권');

    expect(parsed).toMatchObject({ intent: 'flight', place: '오사카', from: '부산' });
    expect(openai.calls).toHaveLength(1);
  });

  it('같은 문장을 두 번 파싱하지 않는다 — 단톡방은 같은 말이 반복된다', async () => {
    await service.extract('부산에서 오사카 가는 항공권');
    await service.extract('부산에서  오사카 가는 항공권!');

    expect(openai.calls).toHaveLength(1);
  });

  it('모델이 뻗어도 의도가 분명하면 지역만 되묻는다', async () => {
    openai.failNext = true;

    const parsed = await service.extract('시부야 호텔 알려줘');

    // 도움말 카드를 주면 "나는 호텔을 물었는데 왜 메뉴가 나오지?" 가 된다.
    expect(parsed).toMatchObject({ intent: 'hotel', place: null });
  });

  it('의도도 못 잡으면 unknown 이다 — 5초를 넘기는 것보다 낫다', async () => {
    openai.failNext = true;

    const parsed = await service.extract('오사카 여행 어때');

    expect(parsed.intent).toBe('unknown');
  });

  it('unknown 은 캐싱하지 않는다 — 모델이 한 번 헛돈 걸 일주일씩 굳히면 안 된다', async () => {
    openai.failNext = true;
    await service.extract('도톤보리 호텔 추천해줘');

    const retry = await service.extract('도톤보리 호텔 추천해줘');

    expect(retry.intent).toBe('hotel');
    expect(retry.place).toBe('도톤보리');
  });

  it('모델이 날짜를 빠뜨려도 고지는 나간다 — 정규식으로 한 번 더 훑는다', async () => {
    const parsed = await service.extract('부산에서 오사카 항공권 3박4일');

    expect(parsed.ignored).toContain('3박4일'.match(/\d+\s*박(?:\s*\d+\s*일)?/)![0]);
  });
});

describe('조사', () => {
  it('받침에 따라 을/를 을 고른다', () => {
    // ⚠️ "관광지을 찾으세요?" 가 실제로 나갔다. 문구에 조사를 박아두면 안 된다.
    expect(withObjectParticle('관광지')).toBe('관광지를');
    expect(withObjectParticle('호텔')).toBe('호텔을');
    expect(withObjectParticle('항공권')).toBe('항공권을');
    expect(withObjectParticle('오사카 호텔')).toBe('오사카 호텔을');
    expect(withObjectParticle('도톤보리 관광지')).toBe('도톤보리 관광지를');
    // 한글이 아니면 받침 없는 것으로 본다
    expect(withObjectParticle('Osaka Hotel')).toBe('Osaka Hotel를');
  });
});

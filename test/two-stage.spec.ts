import { Logger } from '@nestjs/common';

import { loadConfig } from '../src/config/app.config';
import {
  ResponsesRequest,
  ResponsesResult,
  OpenAiService,
} from '../src/modules/openai/openai.service';
import {
  TwoStageSearch,
  TwoStageTrace,
  newTwoStageTrace,
} from '../src/modules/openai/two-stage';

/**
 * 호텔·항공권·관광지 provider 가 공유하는 2단 파이프라인.
 *
 * 프롬프트와 스키마는 도메인 것이라 여기서 안 본다. 여기서 지키는 건 **흐름**이다 —
 * 특히 "후보가 0개면 2차를 부르지 않는다". 빈손에서 한 번 더 부르면 모델이 없는 것을
 * 지어내고, 그 비용은 우리가 낸다.
 *
 * ⚠️ **2차는 번호만 받는다.** 항목을 다시 쓰게 하면 모델이 URL 을 고쳐 쓰고(그러면
 *    provider 가 버린다), 출력이 길어 느리고, effort 를 내리면 필수 칸을 빈 문자열로
 *    채워 결과가 0건이 된다. 번호는 범위 검사로 끝난다.
 */

interface Query {
  city: string;
}

/** 두 호출에 각각 무엇을 돌려줄지 대본으로 받는다. */
class ScriptedOpenAi {
  enabled = true;
  readonly webSearchToolSpec = { type: 'web_search' };
  readonly calls: ResponsesRequest[] = [];

  constructor(private readonly script: Partial<ResponsesResult>[]) {}

  respond(req: ResponsesRequest): Promise<ResponsesResult> {
    this.calls.push(req);
    const next = this.script[this.calls.length - 1] ?? {};
    return Promise.resolve({
      text: next.text ?? '',
      searchCalls: next.searchCalls ?? 1,
      status: next.status ?? 'completed',
      ms: next.ms ?? 7,
    });
  }
}

class TestSearch extends TwoStageSearch<Query> {
  protected readonly logger = new Logger('TestSearch');
  protected readonly label = 'test';

  protected readonly searchInstructions = '후보를 모아라';
  protected readonly candidateSchema = { name: 'test_candidates' };
  protected readonly rankInstructions = '골라라';

  /** 테스트가 한 번에 몇 개까지 고르게 할지. 기본 2개면 자르기까지 확인된다. */
  limit = 2;

  protected subjectOf(query: Query): string {
    return `city=${query.city}`;
  }
  protected limitOf(): number {
    return this.limit;
  }
  protected searchInput(query: Query, wanted: number): string {
    return `${query.city} 에서 ${wanted}개를 찾아라`;
  }
  protected rankInput(query: Query, candidates: string): string {
    return `${query.city} 후보: ${candidates}`;
  }

  /** 도메인 provider 의 searchTraced 가 하는 일을 최소한으로 흉내 낸다. */
  async run(query: Query): Promise<{ picks: unknown[]; trace: TwoStageTrace }> {
    const trace = newTwoStageTrace();
    const candidates = await this.findCandidates(query, trace);
    if (!candidates) return { picks: [], trace };
    return { picks: await this.rank(query, candidates, trace), trace };
  }
}

function build(script: Partial<ResponsesResult>[]) {
  const openai = new ScriptedOpenAi(script);
  const search = new TestSearch(loadConfig(), openai as unknown as OpenAiService);
  return { search, openai };
}

const FOUND = {
  text: JSON.stringify({ candidates: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }),
};
/** 2차는 번호만 낸다. 1번 = 후보 B. */
const PICKED = { text: JSON.stringify({ picks: [1] }) };

describe('2단 웹 검색 파이프라인', () => {
  it('번호를 후보 객체로 돌려준다 — 모델이 항목을 다시 쓰지 않는다', async () => {
    const { search, openai } = build([FOUND, PICKED]);

    const { picks, trace } = await search.run({ city: '오사카' });

    expect(picks).toEqual([{ name: 'B' }]);
    expect(openai.calls).toHaveLength(2);
    expect(trace.candidates).toBe(3);
    expect(trace.picks).toBe(1);
  });

  it('후보에 번호를 붙여 보여준다 — 줄 맨 앞이 번호여야 세다가 안 틀린다', async () => {
    const { search, openai } = build([FOUND, PICKED]);

    await search.run({ city: '오사카' });

    const input = String(openai.calls[1].input);
    expect(input).toContain('0) {"name":"A"}');
    expect(input).toContain('1) {"name":"B"}');
  });

  it('범위 밖 번호는 버린다 — 지어낼 자리가 없다는 게 번호를 쓰는 이유다', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ picks: [7, 0, -1] }) }]);

    const { picks } = await search.run({ city: '오사카' });

    expect(picks).toEqual([{ name: 'A' }]);
  });

  it('같은 번호가 두 번 오면 한 번만 쓴다 — 카드에 같은 줄이 두 번 나간다', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ picks: [2, 2, 0] }) }]);

    const { picks } = await search.run({ city: '오사카' });

    expect(picks).toEqual([{ name: 'C' }, { name: 'A' }]);
  });

  it('요청한 개수를 넘게 와도 잘라낸다', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ picks: [0, 1, 2] }) }]);

    const { picks } = await search.run({ city: '오사카' }); // limit = 2

    expect(picks).toEqual([{ name: 'A' }, { name: 'B' }]);
  });

  it('전부 범위 밖이면 경고한다 — 빈 카드의 원인을 1차에서 찾지 않도록', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ picks: [9, 10] }) }]);
    const warn = jest.spyOn(search['logger'], 'warn');

    const { picks } = await search.run({ city: '오사카' });

    expect(picks).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('범위 밖 번호만 냈다'));
    warn.mockRestore();
  });

  // ⚠️ 이 테스트가 이 파일의 이유다.
  it('**후보가 0개면 2차를 부르지 않는다** — 빈손에서 고르라고 하면 지어낸다', async () => {
    const { search, openai } = build([{ text: JSON.stringify({ candidates: [] }) }, PICKED]);

    const { picks, trace } = await search.run({ city: '오사카' });

    expect(picks).toEqual([]);
    expect(openai.calls).toHaveLength(1); // 1차만
    expect(trace.candidates).toBe(0);
  });

  it('1차 응답이 JSON 이 아니어도 터지지 않고 빈손으로 끝낸다', async () => {
    const { search, openai } = build([{ text: '검색을 진행해도 될까요?' }, PICKED]);

    const { picks } = await search.run({ city: '오사카' });

    expect(picks).toEqual([]);
    expect(openai.calls).toHaveLength(1);
  });

  it('1차는 web_search 를 required 로 건다 — auto 면 모델이 건너뛴다', async () => {
    const { search, openai } = build([FOUND, PICKED]);

    await search.run({ city: '오사카' });

    expect(openai.calls[0].toolChoice).toBe('required');
    expect(openai.calls[0].tools).toEqual([{ type: 'web_search' }]);
    // 2차는 검색이 아니라 판단이다. 툴을 주면 괜히 또 뒤진다.
    expect(openai.calls[1].tools).toBeUndefined();
  });

  it('검색을 한 번도 안 돌았으면 경고하되 결과는 그대로 쓴다', async () => {
    const { search } = build([{ ...FOUND, searchCalls: 0 }, PICKED]);
    const warn = jest.spyOn(search['logger'], 'warn');

    const { picks, trace } = await search.run({ city: '오사카' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('web_search 가 호출되지 않았다'));
    expect(trace.searchCalls).toBe(0);
    // 경고는 하지만 버리지는 않는다 — 기억으로 답한 결과라도 없는 것보단 낫다.
    expect(picks).toHaveLength(1);
    warn.mockRestore();
  });

  it('2차가 빈손이면 빈 배열 — 1차 후보를 대신 내보내지 않는다', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ picks: [] }), status: 'incomplete' }]);

    const { picks } = await search.run({ city: '오사카' });

    // 비교·선별을 그만둘 거면 2차 호출을 없애는 결정으로 해야 한다. 실패 경로에
    // 숨기면 모델이 고르기를 멈춘 날에도 카드는 멀쩡해 보인다.
    expect(picks).toEqual([]);
  });

  it('picks 가 아닌 키로 오면 못 고른 것으로 본다', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ hotels: [{ name: 'A' }] }) }]);

    const { picks } = await search.run({ city: '오사카' });

    expect(picks).toEqual([]);
  });

  it('로그는 label 과 subject 로 찾을 수 있어야 한다', async () => {
    const { search } = build([FOUND, PICKED]);
    const log = jest.spyOn(search['logger'], 'log');

    await search.run({ city: '오사카' });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('test search city=오사카'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('test rank city=오사카'));
  });

  it('단계별 소요 시간을 따로 담는다', async () => {
    const { search } = build([{ ...FOUND, ms: 9000 }, { ...PICKED, ms: 400 }]);

    const { trace } = await search.run({ city: '오사카' });

    expect(trace.searchMs).toBe(9000);
    expect(trace.rankMs).toBe(400);
  });
});

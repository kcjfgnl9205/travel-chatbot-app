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
  protected readonly pickSchema = { name: 'test_picks' };
  protected readonly pickKey = 'items';

  protected subjectOf(query: Query): string {
    return `city=${query.city}`;
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

const FOUND = { text: JSON.stringify({ candidates: [{ name: 'A' }, { name: 'B' }] }) };
const PICKED = { text: JSON.stringify({ items: [{ name: 'A' }] }) };

describe('2단 웹 검색 파이프라인', () => {
  it('1차에서 후보를 모으고 2차에서 고른다', async () => {
    const { search, openai } = build([FOUND, PICKED]);

    const { picks, trace } = await search.run({ city: '오사카' });

    expect(picks).toEqual([{ name: 'A' }]);
    expect(openai.calls).toHaveLength(2);
    expect(trace.candidates).toBe(2);
    expect(trace.picks).toBe(1);
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
  });

  it('2차가 빈손이면 빈 배열 — 1차 후보를 대신 내보내지 않는다', async () => {
    const { search } = build([FOUND, { text: JSON.stringify({ items: [] }), status: 'incomplete' }]);

    const { picks } = await search.run({ city: '오사카' });

    expect(picks).toEqual([]);
  });

  it('pickKey 가 아닌 키로 오면 못 고른 것으로 본다', async () => {
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

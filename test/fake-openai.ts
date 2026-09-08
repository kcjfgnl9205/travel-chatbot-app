import {
  ResponsesRequest,
  ResponsesResult,
} from '../src/modules/openai/openai.service';

/**
 * 테스트용 OpenAI 대역.
 *
 * 발화 파싱이 모델 호출로 바뀌면서, 진짜 OpenAiService 를 그대로 두면
 * 테스트가 실제 API 를 때린다. 여기서 결정론적으로 답한다.
 */
export class FakeOpenAiService {
  enabled = true;
  readonly webSearchToolSpec = { type: 'web_search' };

  /** 어떤 요청이 몇 번 갔는지. "같은 문장을 두 번 파싱하지 않는다" 검증에 쓴다. */
  readonly calls: ResponsesRequest[] = [];
  /** 파싱이 느리거나 실패하는 상황을 흉내 낼 때. */
  failNext = false;
  timeoutNext = false;
  delayMs = 0;

  async respond(req: ResponsesRequest): Promise<ResponsesResult> {
    this.calls.push(req);
    if (this.delayMs)
      await new Promise((r) => setTimeout(r, this.delayMs).unref());
    if (this.timeoutNext) {
      this.timeoutNext = false;
      // 진짜 OpenAiService 가 AbortController 로 끊었을 때와 같은 메시지.
      throw new Error(`openai timeout after ${req.timeoutMs ?? 0}ms`);
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error('openai unavailable');
    }

    const format = req.format as { name?: string } | undefined;
    if (format?.name === 'parsed_utterance') {
      return {
        text: JSON.stringify(parseUtterance(req.input)),
        searchCalls: 0,
        status: 'completed',
        ms: 1,
      };
    }
    if (format?.name === 'parsed_flight_utterance') {
      return {
        text: JSON.stringify(parseFlightUtterance(req.input)),
        searchCalls: 0,
        status: 'completed',
        ms: 1,
      };
    }
    throw new Error(
      `FakeOpenAiService: 예상치 못한 요청 format=${format?.name}`,
    );
  }

  reset(): void {
    this.calls.length = 0;
    this.failNext = false;
    this.timeoutNext = false;
    this.delayMs = 0;
  }
}

/**
 * 모델이 할 일을 표로 대신한다.
 *
 * 진짜 모델은 자연어를 이해하지만, 테스트는 "NluService 가 모델 답을 어떻게 다루는가"를
 * 보는 것이지 모델 성능을 보는 게 아니다. 오타 교정(오사카→오사카)도 여기서 흉내 낸다.
 */
const CITIES: [string, string, string][] = [
  // [발화에 등장하는 표기, 표준 한국어명, 슬러그]
  ['인천', '인천', 'incheon'],
  ['서울', '서울', 'seoul'],
  ['부산', '부산', 'busan'],
  ['오사카', '오사카', 'osaka'],
  ['오사카', '오사카', 'osaka'], // 오타
  ['오오사카', '오사카', 'osaka'], // 오타
  ['도쿄', '도쿄', 'tokyo'],
  ['동경', '도쿄', 'tokyo'], // 다른 표기
  ['후쿠오카', '후쿠오카', 'fukuoka'],
  ['방콕', '방콕', 'bangkok'],
  ['bangkok', '방콕', 'bangkok'],
  ['파리', '파리', 'paris'],
  ['이스탄불', '이스탄불', 'istanbul'],
  ['하노이', '하노이', 'hanoi'],
  ['세부', '세부', 'cebu'],
  ['리스본', '리스본', 'lisbon'],
  ['다낭', '다낭', 'danang'],
  ['없는도시', '없는도시', 'nowhere'],
  ['asdf', 'asdf', 'asdf'],
  ['zxcv', 'zxcv', 'zxcv'],
];

export function parseUtterance(utterance: string): Record<string, unknown> {
  const lowered = utterance.toLowerCase();

  let found: [string, string, string] | null = null;
  let at = Number.MAX_SAFE_INTEGER;
  for (const entry of CITIES) {
    const idx = lowered.indexOf(entry[0].toLowerCase());
    if (idx >= 0 && idx < at) {
      at = idx;
      found = entry;
    }
  }

  const guests = /(\d+)\s*(?:명|인)/.exec(utterance);
  const nights = /(\d+)\s*박/.exec(utterance);

  return {
    city_name: found?.[1] ?? null,
    city_slug: found?.[2] ?? null,
    guests: guests ? Number(guests[1]) : null,
    nights: nights ? Number(nights[1]) : null,
  };
}

/**
 * 항공권 파싱을 표로 대신한다.
 *
 * 진짜 모델은 "다음달 3일" 을 절대 날짜로 바꿔주지만, 테스트가 확인하려는 건
 * FlightNluService 가 모델 답을 어떻게 다루는가다. 그래서 발화에 이미 들어 있는
 * YYYY-MM-DD 만 읽고, 그런 게 없으면 날짜 없음으로 답한다.
 *
 * ⚠️ input 은 "오늘은 YYYY-MM-DD 이다.\n발화: ..." 형태로 온다. 앞의 오늘 날짜를
 *    발화의 날짜로 오인하지 않도록 발화 부분만 떼서 본다.
 */
export function parseFlightUtterance(input: string): Record<string, unknown> {
  const utterance = input.includes('발화:') ? input.split('발화:')[1] : input;
  const lowered = utterance.toLowerCase();

  const cityAt = (skip = 0): [string, string, string] | null => {
    const hits = CITIES.map((entry) => ({
      entry,
      at: lowered.indexOf(entry[0].toLowerCase()),
    }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at);
    // 같은 도시가 표에 여러 표기로 들어 있어 중복 히트가 난다. 슬러그로 압축한다.
    const unique = hits.filter(
      (h, i) => hits.findIndex((x) => x.entry[2] === h.entry[2]) === i,
    );
    return unique[skip]?.entry ?? null;
  };

  // "인천에서 오사카" 처럼 두 도시가 나오면 앞이 출발지, 뒤가 도착지다.
  const first = cityAt(0);
  const second = cityAt(1);
  const origin = second ? first : null;
  const destination = second ?? first;

  const dates = utterance.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const pax = /(\d+)\s*(?:명|인)/.exec(utterance);
  const round = /왕복/.test(utterance) || dates.length > 1;

  return {
    origin_name: origin?.[1] ?? null,
    origin_slug: origin?.[2] ?? null,
    origin_code: origin ? AIRPORTS[origin[2]] ?? null : null,
    destination_name: destination?.[1] ?? null,
    destination_slug: destination?.[2] ?? null,
    destination_code: destination ? AIRPORTS[destination[2]] ?? null : null,
    depart_date: dates[0] ?? null,
    return_date: round ? (dates[1] ?? null) : null,
    trip_type: round ? 'round' : 'oneway',
    passengers: pax ? Number(pax[1]) : null,
    cabin: /비즈니스/.test(utterance) ? 'business' : null,
  };
}

/** 모델이 아는 척하는 공항 코드. 표에 없으면 null 이 온다 (실제 모델도 그렇다). */
const AIRPORTS: Record<string, string> = {
  seoul: 'ICN',
  incheon: 'ICN',
  busan: 'PUS',
  osaka: 'KIX',
  tokyo: 'NRT',
  fukuoka: 'FUK',
  bangkok: 'BKK',
  danang: 'DAD',
};

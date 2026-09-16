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
    if (format?.name === 'parsed_intent') {
      return {
        text: JSON.stringify(parseIntent(req.input)),
        searchCalls: 0,
        status: 'completed',
        ms: 1,
      };
    }
    if (format?.name === 'country_cities') {
      return {
        text: JSON.stringify({ cities: COUNTRY_CITIES[req.input.trim()] ?? [] }),
        searchCalls: 0,
        status: 'completed',
        ms: 1,
      };
    }
    if (format?.name === 'place_lookup') {
      return {
        text: JSON.stringify(lookupPlace(req.input)),
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

/** 모델이 아는 도시. [발화에 등장하는 표기, 표준 한국어명, 슬러그] */
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

/**
 * 의도·지역 추출을 표로 대신한다.
 *
 * 진짜 모델은 자연어를 이해하지만, 테스트가 보는 건 "IntentService 가 모델 답을
 * 어떻게 다루는가" 이지 모델 성능이 아니다. 오타 교정도 여기서 흉내 낸다.
 */
export function parseIntent(utterance: string): Record<string, unknown> {
  const lowered = utterance.toLowerCase();

  const intent = /호텔|숙소/.test(utterance)
    ? 'hotel'
    : /항공|비행기|티켓/.test(utterance)
      ? 'flight'
      : /관광|명소|맛집|볼거리|가볼|여행지/.test(utterance)
        ? 'attraction'
        : 'unknown';

  // "부산에서 오사카" 처럼 두 지명이 나오면 앞이 출발지, 뒤가 목적지다.
  const hits = [...CITIES, ...COUNTRIES, ...AREAS]
    .map((entry) => ({ entry, at: lowered.indexOf(entry[0].toLowerCase()) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);
  const unique = hits.filter(
    (h, i) => hits.findIndex((x) => x.entry[2] === h.entry[2]) === i,
  );
  const origin = unique.length > 1 && /에서|출발/.test(utterance) ? unique[0] : null;
  const destination = origin ? unique[1] : unique[0];

  const ignored: string[] = [];
  for (const pattern of [/\d+\s*명/g, /\d+\s*월\s*\d+\s*일?/g, /\d+\s*박/g]) {
    for (const m of utterance.matchAll(pattern)) ignored.push(m[0]);
  }

  return {
    intent,
    place: destination?.entry[1] ?? null,
    from: origin?.entry[1] ?? null,
    trip_type: /편도/.test(utterance) ? 'ow' : 'rt',
    ignored,
  };
}

/** 나라 → 대표 도시. 진짜 모델은 더 많이 알지만 테스트에는 이걸로 충분하다. */
const COUNTRY_CITIES: Record<string, { name: string; blurb: string }[]> = {
  베트남: [
    { name: '다낭', blurb: '미케 · 한강' },
    { name: '하노이', blurb: '호안끼엠 · 구시가' },
    { name: '호치민', blurb: '1군 · 벤탄' },
    { name: '나트랑', blurb: '해변 · 빈펄' },
  ],
  일본: [
    { name: '도쿄', blurb: '신주쿠 · 시부야' },
    { name: '오사카', blurb: '도톤보리 · 난바' },
    { name: '후쿠오카', blurb: '하카타 · 텐진' },
  ],
};

/** 사전에 없는 지명을 모델이 정리해주는 상황. */
export function lookupPlace(raw: string): Record<string, unknown> {
  const country = Object.keys(COUNTRY_CITIES).find((c) => raw.includes(c));
  if (country) {
    return {
      canonical_name: country,
      slug: country === '베트남' ? 'vietnam' : 'japan',
      country_code: country === '베트남' ? 'VN' : 'JP',
      kind: 'country',
      iata: null,
      parent_name: null,
      // 진짜 스키마와 같다 — 나라를 해석할 때 도시 목록을 같이 준다.
      cities: COUNTRY_CITIES[country] ?? [],
    };
  }

  const area = AREAS.find((a) => raw.includes(a[0]));
  if (area) {
    return {
      canonical_name: area[1],
      slug: area[2],
      country_code: 'JP',
      kind: 'area',
      iata: null,
      parent_name: area[3],
      cities: [],
    };
  }

  const city = CITIES.find((c) => raw.toLowerCase().includes(c[0].toLowerCase()));
  if (city) {
    return {
      canonical_name: city[1],
      slug: city[2],
      country_code: null,
      kind: 'city',
      iata: AIRPORTS[city[2]] ?? null,
      parent_name: null,
      cities: [],
    };
  }

  return {
    canonical_name: null,
    slug: null,
    country_code: null,
    kind: 'city',
    iata: null,
    parent_name: null,
    cities: [],
  };
}

/** 나라. 발화에서 지명으로 잡혀야 하므로 도시 표와 같은 모양으로 둔다. */
const COUNTRIES: [string, string, string][] = [
  ['베트남', '베트남', 'vietnam'],
  ['일본', '일본', 'japan'],
];

/** 사전(city-table)에 없는 세부 지역. [발화 표기, 표준명, 슬러그, 부모 도시] */
const AREAS: [string, string, string, string][] = [
  ['도톤보리', '도톤보리', 'dotonbori', '오사카'],
  ['시부야', '시부야', 'shibuya', '도쿄'],
];

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

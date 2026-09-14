import { SearchKind, TripType } from '../search/search.types';

/**
 * 발화 하나에서 뽑아내는 전부.
 *
 * 예전에는 도메인마다 파서가 따로 있었고(호텔 파서·항공권 파서), 블록이 도메인을
 * 정해줬기 때문에 그게 가능했다. 이제 진입점이 폴백 하나뿐이라 **무엇을 묻는지부터**
 * 우리가 정해야 한다. 그래서 스키마가 하나로 합쳐졌다.
 */
export interface ParsedIntent {
  intent: SearchKind | 'unknown';
  /**
   * 지명. **도시가 아니어도 그대로 둔다** ("도톤보리" OK).
   *
   * 검증하지 않는 게 핵심이다 — 아는 도시인지 묻지 않고 뽑힌 지명을 그대로 검색에
   * 넘기기 때문에 세부 지역이 저절로 처리된다.
   */
  place: string | null;
  /** 항공권 출발지. 말하지 않았으면 null (서울로 채운다). */
  from: string | null;
  /** 기본은 왕복(rt). "편도" 의미가 있을 때만 ow. */
  tripType: TripType;
  /**
   * 검색에 **반영하지 않은** 조건. ["4명", "9월 22일~24일"]
   *
   * 캐시를 지역으로만 가르기 때문에 날짜·인원은 버려진다. 버렸다는 사실을 카드
   * 아래 안내에 적기 위해 여기 담는다. 고지가 없으면 사용자는 그 날짜에 예약 불가한
   * 호텔을 보고 속았다고 느낀다.
   */
  ignored: string[];
}

export const UNKNOWN_INTENT: ParsedIntent = {
  intent: 'unknown',
  place: null,
  from: null,
  tripType: 'rt',
  ignored: [],
};

/**
 * 1차 필터. **이게 없으면 AI 를 아예 부르지 않는다.**
 *
 * 단톡방에는 봇을 멘션한 잡담이 섞인다. 인사말까지 모델에 보내면 그게 그대로 요금이다.
 */
export const TRAVEL_HINT =
  /호텔|숙소|묵을|잘곳|잘 곳|숙박|리조트|항공|비행기|비행편|티켓|여행|관광|명소|가볼|볼거리|놀거리|맛집|구경/;

const HOTEL_HINT = /호텔|숙소|묵을|잘곳|잘 곳|숙박|리조트|호스텔|료칸/;
const FLIGHT_HINT = /항공|비행기|비행편|티켓|왕복|편도/;
const ATTRACTION_HINT = /관광|명소|가볼|볼거리|놀거리|맛집|구경|여행지/;

/** "편도" 단서. 없으면 왕복으로 본다 — 항공권 질문의 대부분이 왕복이다. */
const ONEWAY_HINT = /편도|가는\s*편만|원웨이|one\s*way/i;

/**
 * 키워드만으로 의도를 정한다. 애매하면 unknown 을 주고 모델에게 넘긴다.
 *
 * 순서가 있다 — "오사카 항공권이랑 호텔" 같은 문장에서 하나를 골라야 한다.
 * 호텔을 먼저 보는 이유는 그게 우리가 가장 잘 답하는 도메인이라서다.
 */
export function intentFromKeywords(utterance: string): SearchKind | 'unknown' {
  if (HOTEL_HINT.test(utterance)) return 'hotel';
  if (FLIGHT_HINT.test(utterance)) return 'flight';
  if (ATTRACTION_HINT.test(utterance)) return 'attraction';
  return 'unknown';
}

/**
 * 대표 명령어(`/호텔`·`/항공권`·`/여행지`)로 들어온 발화.
 *
 * 카카오의 대표 명령어는 **라우팅이 아니다.** 고르면 `"여행지"` 라는 텍스트가 평범한
 * 발화로 전송될 뿐이고, 사용자는 보통 뒤에 지명을 이어 붙인다("여행지 오사카").
 * 그 모양은 의도가 이미 확정이라 모델을 부를 이유가 없다.
 *
 * ⚠️ **슬래시가 붙어 올 수 있다.** 메뉴에서 고르면 슬래시 없이 오지만 사용자가
 *    `/호텔 오사카` 처럼 직접 치기도 한다. 앞의 `/` 를 빼고 보지 않으면 이 경로를
 *    통째로 놓치고, 사전에 없는 지명(`/여행지 도톤보리`)이 모델로 새어 나간다.
 *
 * ⚠️ **한 단어일 때만 지명으로 본다.** `호텔 예약 어떻게 해?` 같은 문장에서
 *    "예약 어떻게 해?" 를 지명으로 등록하면 places 테이블이 쓰레기로 찬다.
 *    사전에 없는 지명("호텔 도톤보리")을 모델 없이 살리는 게 목적이고, 그건 한 단어다.
 */
const COMMAND = /^\s*\/?\s*(호텔|항공권|여행지|관광지|맛집)\s+(\S+)\s*$/;

const COMMAND_INTENT: Record<string, SearchKind> = {
  호텔: 'hotel',
  항공권: 'flight',
  여행지: 'attraction',
  관광지: 'attraction',
  맛집: 'attraction',
};

/** 지명 뒤에 붙는 서술어. "여행지 오사카 추천해줘" 는 COMMAND 에 안 걸리므로 여기선 안 쓴다. */
export function fromCommand(utterance: string): ParsedIntent | null {
  const matched = COMMAND.exec(utterance);
  if (!matched) return null;

  const intent = COMMAND_INTENT[matched[1]];
  const place = matched[2].trim();
  // 서술어 한 단어가 지명 자리에 온 경우를 막는다 ("호텔 추천해줘").
  if (!intent || !place || NOT_A_PLACE.test(place)) return null;

  return {
    intent,
    place,
    from: null,
    tripType: tripTypeOf(utterance),
    ignored: ignoredConditions(utterance),
  };
}

/** 지명이 아닌 게 뻔한 한 단어. 이 목록에 없어도 검색이 비면 드러난다. */
const NOT_A_PLACE =
  /^(추천|추천해줘|추천해주세요|찾아줘|찾아주세요|알려줘|알려주세요|검색|보여줘|예약|어디|어디야|뭐야|가격|얼마|좀|해줘|주세요)$/;

export function tripTypeOf(utterance: string): TripType {
  return ONEWAY_HINT.test(utterance) ? 'ow' : 'rt';
}

/**
 * 발화에서 **검색에 반영하지 않는 조건**을 긁어낸다.
 *
 * 모델도 이걸 뽑지만 여기서 한 번 더 본다. 이유가 둘이다.
 *   · 키워드 경로(모델 호출 0회)에도 고지가 필요하다
 *   · 모델이 날짜를 빠뜨려도 고지는 나가야 한다. **고지 누락이 가장 나쁜 실패다**
 */
const CONDITION_PATTERNS: RegExp[] = [
  /\d+\s*명/g,
  /\d+\s*인(?!천)/g,
  /\d+\s*월\s*\d+\s*일?(?:\s*[~\-–]\s*\d+\s*일?)?/g,
  /\d+\s*\/\s*\d+(?:\s*[~\-–]\s*\d+(?:\s*\/\s*\d+)?)?/g,
  /\d+\s*박(?:\s*\d+\s*일)?/g,
  /\d+\s*만원(?:대)?/g,
  /(?:내일|모레|글피|이번\s*주말|이번주|다음\s*주|다음주|담주|다음\s*달|다음달|주말)/g,
];

export function ignoredConditions(utterance: string): string[] {
  const found = new Set<string>();
  for (const pattern of CONDITION_PATTERNS) {
    for (const match of utterance.matchAll(pattern)) {
      const text = match[0].replace(/\s+/g, ' ').trim();
      if (text) found.add(text);
    }
  }
  return [...found];
}

/** 두 곳에서 온 조건을 합친다. 표기가 같은 건 한 번만 남긴다. */
export function mergeIgnored(...lists: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const raw of list) {
      const text = String(raw ?? '').trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, '').toLowerCase();
      if (!seen.has(key)) seen.set(key, text);
    }
  }
  return [...seen.values()].slice(0, 5);
}

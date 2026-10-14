import { TripParams, seoulDate } from './search-url';

/**
 * 발화에서 날짜·인원을 뽑는다. **모델을 부르지 않는다.**
 *
 * 이 파서가 틀려도 손해가 작다는 게 설계의 전제다 — 우리가 만드는 건 **검색 폼이
 * 채워진 페이지**지 예약 확정이 아니다. 10/20 을 잘못 읽으면 사용자는 그 페이지에서
 * 날짜 칸을 고치면 되고, 그건 아무것도 안 넣어서 내일 날짜로 열리는 것보다 낫다.
 * 가격을 틀리는 것과는 성격이 다르다. 그래서 "완벽하지 않은 규칙" 으로 충분하다.
 *
 * ⚠️ **읽지 못한 칸은 null 이다. 여기서 기본값을 채우지 마라** — 기본값은
 *    [search-url.ts](./search-url.ts) `resolveTrip` 한 곳에만 있다. 두 곳에서
 *    채우면 링크가 여는 날짜와 카드에 적는 날짜가 갈린다.
 *
 * ⚠️ **결과를 캐시에 넣지 마라.** 의도 파싱 결과는 발화 해시로 7일간 캐시되는데
 *    (INTENT_CACHE_TTL_MINUTES), 거기에 절대 날짜를 구워 넣으면 오늘 "내일" 로
 *    읽은 날짜가 다음 주에 같은 말을 한 사람에게 그대로 나간다. 그래서 이 함수는
 *    **카드를 그리는 순간** 발화에서 다시 읽는다 (0004 와 같은 이유다).
 */
export function parseTripParams(utterance: string, now: Date): TripParams {
  const today = seoulDate(now);
  const used: string[] = [];
  /** 발화에 나온 순서가 뜻을 가진다 — 앞이 출발일이다. */
  const found: { at: number; date: string }[] = [];
  let text = utterance ?? '';
  let nights: number | null = null;
  let adults: number | null = null;

  const keep = (at: number, raw: string, date: string | null): boolean => {
    if (!date) return false;
    found.push({ at, date });
    if (raw) used.push(raw.trim());
    return true;
  };

  // 인원. '2인천' 같은 지명 조각을 먹지 않게 '인' 뒤를 본다.
  text = scan(text, /(\d{1,2})\s*(?:명|인(?!천))/g, (m) => {
    const n = Number(m[1]);
    if (n < 1 || n > 9) return false;
    adults ??= n;
    used.push(m[0].trim());
    return true;
  });

  // 박수를 먼저 먹는다. '3박 4일' 의 '4일' 을 남기면 아래 '일' 패턴이 날짜로 읽는다.
  text = scan(text, /(\d{1,2})\s*박(?:\s*\d{1,2}\s*일)?/g, (m) => {
    const n = Number(m[1]);
    if (n < 1 || n > 30) return false;
    nights ??= n;
    used.push(m[0].trim());
    return true;
  });

  // 당일치기는 '박수 0' 이다. 날짜를 안 말했어도 귀국일이 출발일과 같아진다.
  text = scan(text, /당일\s*(?:치기|여행)/g, (m) => {
    nights ??= 0;
    used.push(m[0].trim());
    return true;
  });

  // ⚠️ '다음 달 15일' 을 통째로 읽는다. '다음 달' 과 '15일' 을 따로 읽으면
  //    다음 달 1일(출발)과 이번 달 15일(귀국)이 되어 일정이 거꾸로 선다.
  text = scan(text, MONTH_WORD_DAY, (m) =>
    keep(at(m), m[0], monthWordDay(m[1], Number(m[2]), today)),
  );

  // '2주 뒤' · '열흘 뒤' 가 아니라 '10일 뒤'. 숫자만 받는다.
  text = scan(text, AFTER_N, (m) => keep(at(m), m[0], afterDate(Number(m[1]), m[2], today)));

  // '11월 첫째주'. 주 단위로 말하는 사람이 꽤 있다.
  text = scan(text, NTH_WEEK, (m) =>
    keep(at(m), m[0], nthWeek(Number(m[1]), m[2], today)),
  );

  // 범위를 단일 날짜보다 먼저 본다. '10/20~24' 를 단일로 읽으면 24 가 사라진다.
  text = scan(text, RANGE_KO, (m) => keepRange(m, today, keep));
  text = scan(text, RANGE_SLASH, (m) => keepRange(m, today, keep));

  // 단일 날짜. '10월 20일' · '10/20' · '20일'.
  text = scan(text, /(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g, (m) =>
    keep(at(m), m[0], monthDay(Number(m[1]), Number(m[2]), today)),
  );
  text = scan(text, /(\d{1,2})\s*\/\s*(\d{1,2})/g, (m) =>
    keep(at(m), m[0], monthDay(Number(m[1]), Number(m[2]), today)),
  );
  // '3일간'·'3일 동안' 은 기간이지 날짜가 아니다.
  text = scan(text, /(\d{1,2})\s*일(?!\s*(?:간|동안))/g, (m) =>
    keep(at(m), m[0], dayOnly(Number(m[1]), today)),
  );

  // 요일 범위를 단일 요일보다 먼저 본다.
  text = scan(text, WEEKDAY_RANGE, (m) => keepWeekdayRange(m, today, keep));

  // 상대 날짜. '내일'·'이번 주말'·'다음 주 금요일'.
  text = scan(text, WEEKDAY, (m) => keep(at(m), m[0], weekdayDate(m[1], m[2], today)));
  scan(text, RELATIVE, (m) => keep(at(m), m[0], relativeDate(squeeze(m[0]), today)));

  found.sort((a, b) => a.at - b.at);
  return {
    // ⚠️ 날짜가 하나면 **출발일**이다. 귀국일만 말하는 사람은 드물고, 틀려도
    //    사용자가 폼에서 고친다.
    departDate: found[0]?.date ?? null,
    returnDate: found[1]?.date ?? null,
    nights,
    adults,
    used,
  };
}

/**
 * 반영한 표현을 고지 목록에서 뺀다. 반영해놓고 "반영 안 됐어요" 라고 하면 안 된다.
 *
 * ⚠️ **같은 발화를 두 파서가 각자 끊는다.** 고지용 파서는 "다음 주" 까지만 보고
 *    ([intent.types.ts](../intent/intent.types.ts) ignoredConditions) 여기는
 *    "다음 주 금요일" 을 통째로 읽는다. 그래서 완전히 같은 표기만 빼면 링크에는
 *    10월 23일이 들어간 채 "날짜는 반영되지 않았어요" 가 붙는다 — 실제로 그랬다.
 *    **우리가 읽은 표현에 포함되면 뺀다.**
 */
export function withoutUsed(ignored: string[], used: string[]): string[] {
  const consumed = used.map(normalize).filter(Boolean);
  return ignored.filter((text) => {
    const key = normalize(text);
    return !consumed.some((mine) => mine === key || mine.includes(key));
  });
}

function normalize(text: string): string {
  return squeeze(text).toLowerCase();
}

// ------------------------------------------------------------------ 패턴
/** '10월 20일~24일' · '10월 20일 ~ 11월 2일'. 뒷쪽 월은 없을 수 있다. */
const RANGE_KO = /(\d{1,2})\s*월\s*(\d{1,2})\s*일?\s*[~\-–]\s*(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일?/g;
/** '10/20~24' · '10/20 ~ 11/2'. */
const RANGE_SLASH = /(\d{1,2})\s*\/\s*(\d{1,2})\s*[~\-–]\s*(?:(\d{1,2})\s*\/\s*)?(\d{1,2})/g;
/** '다음 달 15일' · '이번달 3일'. */
const MONTH_WORD_DAY = /(이번|다음|담)\s*달\s*(\d{1,2})\s*일?/g;
/** '2주 뒤' · '10일 후' · '3개월 뒤'. */
const AFTER_N = /(\d{1,2})\s*(주일?|일|개월|달)\s*(?:뒤|후)/g;
/** '11월 첫째주' · '12월 마지막주'. */
const NTH_WEEK = /(\d{1,2})\s*월\s*(첫|둘|셋|넷|다섯|마지막|막)\s*째?\s*주/g;
/** '다음 주 금요일' · '금요일'. */
const WEEKDAY = /(이번\s*주|다음\s*주|담주)?\s*([월화수목금토일])요일/g;
/** '다음주 수요일~금요일' · '수요일부터 금요일까지'. */
const WEEKDAY_RANGE =
  /(이번\s*주|다음\s*주|담주)?\s*([월화수목금토일])요일\s*(?:[~\-–]|부터)\s*(?:(이번\s*주|다음\s*주|담주)\s*)?([월화수목금토일])요일(?:\s*까지)?/g;
const RELATIVE =
  /오늘|내일|모레|글피|이번\s*주말|다음\s*주말|이번\s*주|다음\s*주|담주|이번\s*달|다음\s*달|주말/g;

const WEEKDAY_INDEX = '일월화수목금토';

// ------------------------------------------------------------------ 날짜 계산
/**
 * 범위 하나를 날짜 둘로. 끝이 시작보다 앞서면 **다음 달**로 넘긴다
 * ('10/30~2' 는 10월 30일부터 11월 2일이다).
 */
function keepRange(
  m: RegExpMatchArray,
  today: string,
  keep: (at: number, raw: string, date: string | null) => boolean,
): boolean {
  const month = Number(m[1]);
  const start = monthDay(month, Number(m[2]), today);
  if (!start) return false;
  // ⚠️ **끝은 오늘이 아니라 시작일을 기준으로 센다.** 오늘로 재면 '10/30~2' 의 '2' 가
  //    이미 지난 10월 2일로 읽혀 내년으로 굴러간다.
  const day = Number(m[4]);
  const year = Number(start.slice(0, 4));
  let end = m[3] ? isoOf(year, Number(m[3]), day) : isoOf(year, month, day);
  if (end && end < start) {
    // 끝이 시작보다 앞선다 — 달을 넘는 일정이다. '10/30~2' 는 11월 2일이다.
    end = m[3] ? isoOf(year + 1, Number(m[3]), day) : nextMonthDay(year, month, day);
  }
  if (!keep(at(m), m[0], start)) return false;
  // 귀국일은 같은 표현에서 나왔다. 자리를 반 칸 뒤로 둬서 출발일 다음에 서게 한다
  // (표현 전체는 출발일 쪽에 한 번만 담긴다 — 고지에서 뺄 때 한 덩어리여야 한다).
  if (end) keep(at(m) + 0.5, '', end);
  return true;
}

/**
 * 요일 범위를 날짜 둘로.
 *
 * ⚠️ **끝 요일은 시작과 같은 주에서 센다.** 따로 세면 "다음주 수요일~금요일" 의
 *    금요일이 이번 주 금요일이 되어 **귀국일이 출발일보다 앞선다** — 실제로
 *    그렇게 나갔다 (10/21 출발 · 10/16 귀국).
 */
function keepWeekdayRange(
  m: RegExpMatchArray,
  today: string,
  keep: (at: number, raw: string, date: string | null) => boolean,
): boolean {
  const start = weekdayDate(m[1], m[2], today);
  const endIndex = WEEKDAY_INDEX.indexOf(m[4]);
  if (!start || endIndex < 0) return false;

  // 시작일로부터 다가오는 그 요일. 같은 요일이면 한 주 뒤다.
  let end = comingWeekday(start, endIndex);
  if (end === start) end = addDays(end, 7);
  // '이번 주 금요일~다음 주 월요일' 처럼 뒤쪽에도 주를 말했으면 그만큼 민다.
  if (/다음|담/.test(m[3] ?? '')) end = addDays(end, 7);

  if (!keep(at(m), m[0], start)) return false;
  keep(at(m) + 0.5, '', end);
  return true;
}

function at(m: RegExpMatchArray): number {
  return m.index ?? 0;
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 'M월 D일' → ISO. **지난 날짜면 내년이다** ("1/5" 를 10월에 말하면 내년 1월 5일). */
function monthDay(month: number, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const rolled = month > 12 ? { year: year + 1, month: month - 12 } : { year, month };
  const iso = isoOf(rolled.year, rolled.month, day);
  if (!iso) return null;
  return iso < today ? isoOf(rolled.year + 1, rolled.month, day) : iso;
}

/** 'D일' → ISO. 이번 달 그 날, 지났으면 다음 달. */
function dayOnly(day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const iso = isoOf(year, month, day);
  if (iso && iso >= today) return iso;
  return monthDay(month + 1, day, today);
}

/** '다음 달 15일' → 다음 달의 그 날. 없는 날(2월 30일)이면 null 이다. */
function monthWordDay(word: string, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (word === '이번') return isoOf(year, month, day);
  return nextMonthDay(year, month, day);
}

/** '2주 뒤' → 오늘 + 14일. 달·개월은 같은 날짜로 민다. */
function afterDate(count: number, unit: string, today: string): string | null {
  if (count < 1) return null;
  if (unit.startsWith('주')) return addDays(today, count * 7);
  if (unit === '일') return addDays(today, count);
  // '3개월 뒤' — 그 달에 같은 날이 없으면(1/31 → 2/31) 말일로 당긴다.
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1 + count;
  const day = Number(today.slice(8, 10));
  const target = year + Math.floor(month / 12);
  const m = (month % 12) + 1;
  for (let d = day; d > 27; d -= 1) {
    const iso = isoOf(target, m, d);
    if (iso) return iso;
  }
  return isoOf(target, m, day);
}

/**
 * '11월 첫째주' → 11월 1일. 둘째주 8일, 셋째주 15일, 넷째주 22일, 마지막주는 말일-6.
 *
 * 주의 시작을 월요일로 잡는 것이 더 정확하지만, 그렇게 하면 "첫째주" 가 전달 말일이
 * 되기도 한다. 어차피 폼에서 고치는 값이라 **예측 가능한 쪽**을 택했다.
 */
function nthWeek(month: number, word: string, today: string): string | null {
  const index = ['첫', '둘', '셋', '넷', '다섯'].indexOf(word);
  const first = monthDay(month, 1, today);
  if (!first) return null;
  if (index >= 0) return monthDay(month, 1 + index * 7, today) ?? first;
  // 마지막주 — 그 달 말일에서 6일 앞.
  for (let day = 31; day >= 28; day -= 1) {
    const last = isoOf(Number(first.slice(0, 4)), month, day);
    if (last) return addDays(last, -6);
  }
  return first;
}

function relativeDate(word: string, today: string): string | null {
  switch (word) {
    case '오늘':
      return today;
    case '내일':
      return addDays(today, 1);
    case '모레':
      return addDays(today, 2);
    case '글피':
      return addDays(today, 3);
    case '주말':
    case '이번주말':
      return comingWeekday(today, 6);
    case '다음주말':
      return addDays(comingWeekday(today, 6), 7);
    case '다음주':
    case '담주':
      // 다음 주 월요일. 오늘 다음 날부터 세야 수요일에 말한 '다음 주' 가
      // 다다음 주 월요일이 되지 않는다.
      return comingWeekday(addDays(today, 1), 1);
    case '이번주':
      return addDays(today, 1);
    case '이번달':
      return addDays(today, 1);
    case '다음달':
      // 다음 달 어느 날인지는 아무도 말하지 않았다. 1일로 연다 — 폼에서 고치면 된다.
      return firstOfNextMonth(today);
    default:
      return null;
  }
}

function weekdayDate(prefix: string | undefined, name: string, today: string): string | null {
  const target = WEEKDAY_INDEX.indexOf(name);
  if (target < 0) return null;
  const base = comingWeekday(today, target);
  return /다음|담/.test(prefix ?? '') ? addDays(base, 7) : base;
}

/** 오늘 포함해서 다가오는 그 요일. 오늘이 그 요일이면 오늘이다. */
function comingWeekday(from: string, target: number): string {
  const diff = (target - weekdayOf(from) + 7) % 7;
  return addDays(from, diff);
}

function firstOfNextMonth(today: string): string {
  return nextMonthDay(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)!;
}

/** 그 달의 다음 달 며칠. 12월이면 내년 1월이다. */
function nextMonthDay(year: number, month: number, day: number): string | null {
  return month === 12 ? isoOf(year + 1, 1, day) : isoOf(year, month + 1, day);
}

/**
 * 실제로 있는 날짜만 ISO 로. 2월 30일은 null 이다.
 *
 * UTC 로 만들어 UTC 로 읽는다 — 시간대를 섞으면 하루가 밀린다. 여기 들어오는 값은
 * 이미 서울 기준으로 뽑은 `YYYY-MM-DD` 라 산술만 하면 된다.
 */
function isoOf(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * 패턴에 걸린 자리를 **공백으로 덮으면서** 훑는다.
 *
 * 덮는 게 핵심이다 — '3박 4일' 의 '4일' 을 남기면 뒤따르는 '일' 패턴이 그걸 날짜로
 * 읽는다. 도시 사전이 긴 별칭부터 자리를 잡는 것과 같은 방식이다.
 */
function scan(text: string, re: RegExp, fn: (m: RegExpMatchArray) => boolean): string {
  let out = text;
  for (const m of [...text.matchAll(re)]) {
    if (!fn(m)) continue;
    const at = m.index ?? 0;
    out = out.slice(0, at) + ' '.repeat(m[0].length) + out.slice(at + m[0].length);
  }
  return out;
}

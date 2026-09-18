/**
 * 모델이 준 값을 다듬는 헬퍼.
 *
 * 구조화 출력(json_schema)을 걸어도 **모델은 스키마를 지키면서 쓰레기를 넣는다** —
 * 타입은 string 인데 빈 문자열이거나 "정보 없음" 이거나, number 인데 5점 만점 평점을
 * 10점 칸에 넣는다. 그걸 그대로 카드에 태우면 "평점 4.5/10 (실제로는 4.5/5)" 같은
 * 조용히 틀린 값이 사용자에게 나간다.
 *
 * 그래서 provider 마다 같은 함수를 하나씩 들고 있었는데(5벌), 사본마다 조금씩
 * 달라져 있었다 — provider 셋은 "정보 없음" 을 걸렀고 places·intent 는 안 걸렀다.
 * **한 벌로 합치면서 더 엄격한 쪽으로 맞췄다.** 지명이나 의도 자리에 "정보 없음" 이
 * 들어와 봐야 그걸로 검색해 봤자 빈손이고, 원문으로 폴백하는 편이 낫다.
 */

/**
 * 쓸 만한 문자열만 남긴다. 아니면 null.
 *
 * 버리는 것: 문자열이 아닌 값 · 빈 문자열(공백만 포함) · "정보 없음" · "null"/"NULL".
 * 마지막 둘은 모델이 "값이 없다" 를 문자열로 표현한 것이다 — JSON null 로 달라고
 * 시켜도 effort 를 내리면 이렇게 온다.
 */
export function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '정보 없음' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/**
 * 양의 정수만. 0·음수·NaN 은 null.
 *
 * ⚠️ **경유 횟수처럼 0 이 유효한 값에는 쓰면 안 된다** (직항이 0이다).
 *    가격·소요시간처럼 "0 이면 모르는 것" 인 자리에만 쓴다.
 */
export function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * 범위를 벗어난 값은 버린다.
 *
 * 모델이 5점 만점 평점을 10점 칸에 넣기도 한다. 틀린 평점보다 평점 없는 카드가 낫다.
 */
export function bounded(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * 로그에 넣을 길이로 자른다.
 *
 * 한도를 호출부가 준다 — 발화는 40자면 충분하고, 모델 원문은 "왜 못 읽었나" 를
 * 봐야 해서 더 길게 남긴다. 예전에는 파일마다 다른 상수가 함수 안에 박혀 있어
 * 이름은 같은데 동작이 다른 `clip` 이 둘 있었다.
 */
export function clip(value: string, limit: number): string {
  return value.slice(0, limit);
}

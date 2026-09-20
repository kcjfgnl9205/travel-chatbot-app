/**
 * 분 단위 시간을 카드에 찍을 글자로 바꾼다.
 *
 * 항공권의 비행 시간과 관광지의 관람 시간이 **같은 함수를 한 벌씩 들고 있었다.**
 * 구현도 주석도 글자까지 같았는데, 그런 사본은 한쪽만 고쳐지면서 조용히 갈라진다
 * ([parse.ts](./parse.ts) 의 `text` 가 실제로 그랬다 — 사본 다섯 벌이 서로 달랐다).
 * 도메인이 다르다고 "2시간 25분" 이 다르게 읽히지는 않으므로 한 벌로 합쳤다.
 */

/** 145 → '2시간 25분'. 60분 미만이면 분만. */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

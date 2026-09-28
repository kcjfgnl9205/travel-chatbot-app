/**
 * 관광지 카드에 찍히는 글자.
 *
 * 타입 정의([attraction.types.ts](./attraction.types.ts))에서 떼어냈다. 둘이 한
 * 파일에 있으면 "무엇을 받는가" 와 "무엇을 보여주는가" 가 섞인다. 바뀌는 빈도도
 * 다르다 — 스키마는 거의 안 바뀌지만 카드 문구는 40자 한 줄을 두고 계속 다툰다.
 */

import { Attraction } from './attraction.types';

/**
 * listCard 한 줄 설명. **40자 1줄**인데 지금 넣을 게 하나뿐이다.
 *
 * 이 자리는 계속 줄어들었다 —
 *
 *   입장료 · 소요시간   구글이 주지 않고 모델은 지어냈다. 틀린 가격은 없는 가격보다 나쁘다
 *   평점 · 리뷰수       구글 콘텐츠다. `rating` 을 요청하면 Enterprise SKU 가 되고
 *                       무료 한도가 월 1,000회뿐이라 API 자체를 끊었다
 *   카테고리            구글 타입에서 파생된 값이라 같이 걷어냈다
 *
 * 남은 건 **사람이 직접 넣은 위치**뿐이다. 비어 있으면 빈 문자열을 돌려주고,
 * 렌더러가 description 없이 제목만 그린다.
 *
 * ⚠️ 카테고리를 다시 넣고 싶어지면 여기가 아니라 `attractions` 테이블부터다 —
 *    카드에 찍을 값은 전부 DB 에 있어야 한다는 게 이 판의 규칙이다.
 */
export function listDescription(a: Attraction): string {
  return (a.area ?? '').trim();
}

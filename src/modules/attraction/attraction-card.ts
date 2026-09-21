/**
 * 관광지 카드에 찍히는 글자.
 *
 * 타입 정의([attraction.types.ts](./attraction.types.ts))에서 떼어냈다. 둘이 한
 * 파일에 있으면 "무엇을 받는가" 와 "무엇을 보여주는가" 가 섞인다. 바뀌는 빈도도
 * 다르다 — 스키마는 거의 안 바뀌지만 카드 문구는 40자 한 줄을 두고 계속 다툰다.
 */

import { Attraction } from './attraction.types';

/**
 * 평점 표기. '★ 4.4 (61,234)' / '★ 4.4' / '' (모름).
 *
 * 리뷰 수를 같이 보여주는 이유 — 평점 4.8 이 리뷰 3개면 4.3 에 리뷰 5만 개보다
 * 못 믿는다. 별점만 보여주면 그 차이가 지워진다.
 *
 * ⚠️ **구글이 준 값이다.** 화면에 보여주는 이상 출처를 밝혀야 하므로 카드 하단
 *    버튼에 표시가 붙는다(사진 출처와 같은 자리다).
 */
export function ratingText(a: Attraction): string {
  if (!a.rating) return '';
  const stars = `★ ${a.rating.toFixed(1)}`;
  if (!a.userRatingCount) return stars;
  return `${stars} (${a.userRatingCount.toLocaleString('ko-KR')})`;
}

/**
 * listCard 한 줄 설명. **40자 1줄**이라 넣을 수 있는 게 세 조각뿐이다.
 *
 * 우선순위: 평점 → 카테고리 → 위치.
 *
 * 입장료와 소요 시간이 있던 자리다. 그 둘은 구글이 주지 않고 모델은 지어내서
 * 뺐다 — 틀린 가격은 없는 가격보다 나쁘다. 대신 들어온 평점은 **사용자가 고르는 데
 * 실제로 쓰는 값**이고, 지도로 넘어가면 같은 숫자가 다시 보여 앞뒤가 맞는다.
 *
 * 값이 비어 올 수 있으므로 있는 것만 이어 붙인다.
 */
export function listDescription(a: Attraction): string {
  return [ratingText(a), a.category, a.area].filter(Boolean).join(' · ');
}

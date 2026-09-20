/**
 * 관광지 카드에 찍히는 글자.
 *
 * 타입 정의([attraction.types.ts](./attraction.types.ts))에서 떼어냈다. 둘이 한
 * 파일에 있으면 "무엇을 받는가" 와 "무엇을 보여주는가" 가 섞여서, 필드를 하나 볼 때마다
 * 카드 문구까지 지나가야 한다. 바뀌는 빈도도 다르다 — 스키마는 거의 안 바뀌지만
 * 카드 문구는 40자 한 줄을 두고 계속 다툰다.
 *
 * ⚠️ **여기서 환산하지 않는다.** 입장료는 현지 통화 그대로 받은 값이고
 *    ([attraction.types.ts](./attraction.types.ts) admissionFee 주석), 환율을 모르는
 *    채로 원화처럼 보이게 적는 순간 2,700엔이 2,700원이 된다.
 */

import { durationText } from '../../common/duration';
import { Attraction } from './attraction.types';

/**
 * 통화 코드 → 한국인이 읽는 단위.
 *
 * 여기 없는 통화는 코드를 그대로 뒤에 붙인다 ('1,200 MYR'). 모르는 걸 원화로
 * 바꿔 적는 것보다, 읽기 조금 불편해도 **맞는 숫자**를 보여주는 게 낫다.
 */
const CURRENCY_UNITS: Record<string, string> = {
  JPY: '엔',
  KRW: '원',
  USD: '달러',
  EUR: '유로',
  CNY: '위안',
  THB: '바트',
  VND: '동',
  TWD: '대만달러',
  HKD: '홍콩달러',
  SGD: '싱가포르달러',
  PHP: '페소',
  GBP: '파운드',
};

/**
 * 입장료 표기. '무료' / '1,200엔' / '유료' / '' (모름).
 *
 * 환산하지 않는다 — 이 파일 머리말 참고.
 * '유료' 는 정보가 적어 보이지만, "돈을 내야 하는 곳" 이라는 건 일정을 짤 때
 * 알아야 하는 사실이다. 금액을 모른다고 그것까지 숨길 이유는 없다.
 */
export function admissionText(a: Attraction): string {
  if (a.free) return '무료';

  const code = a.admissionCurrency?.toUpperCase();
  // 통화를 모르면 금액도 쓸 수 없다. '1,200' 만 보여주면 원인지 엔인지 알 수 없고,
  // 사용자는 대개 원으로 읽는다 — 그게 정확히 우리가 막으려는 오해다.
  if (!a.admissionFee || !code) return a.free === false ? '유료' : '';

  const amount = a.admissionFee.toLocaleString('ko-KR');
  const unit = CURRENCY_UNITS[code];
  return unit ? `${amount}${unit}` : `${amount} ${code}`;
}

/**
 * listCard 한 줄 설명. **40자 1줄**이라 넣을 수 있는 게 세 조각뿐이다.
 *
 * 우선순위: 입장료 → 소요 시간 → 위치.
 * 한 줄 소개(description)를 여기 넣지 않는 이유 — 소개는 40자에서 잘려 문장이
 * 끊기는데, 그러면 세 조각 다 못 보여주고 잘린 문장만 남는다. 소개는 카드가
 * 아니라 진단·DB 에만 남긴다.
 *
 * AI 결과는 필드가 비어 올 수 있으므로 있는 것만 이어 붙인다.
 */
export function listDescription(a: Attraction): string {
  const bits: string[] = [];
  const admission = admissionText(a);
  if (admission) bits.push(admission);
  if (a.durationMinutes) bits.push(durationText(a.durationMinutes));
  if (a.area) bits.push(a.area);
  else if (a.category) bits.push(a.category);
  return bits.join(' · ');
}

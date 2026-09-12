/**
 * 발화 파싱의 자료구조.
 *
 * 실제 파싱은 [nlu.service.ts](./nlu.service.ts) 가 한다. 순서는
 * **오픈빌더 엔티티 → 도시 사전([city-table.ts](./city-table.ts)) → 모델(gpt-5-mini)** 이다.
 *
 * 사전만으로 끝내지 않는 이유는 카카오 사용자가 "오사카 여행갈건데 4명기준으로 숙소
 * 추천해줘" 처럼 말하고 오타도 내기 때문이다 — 키워드 매칭으로는 인원·박수를 못 뽑는다.
 * 반대로 모델만 쓰지 않는 이유는 그게 5초 예산 안에서 도는 유료 호출이라,
 * "세부 여행지 추천해줘" 처럼 사전으로 충분한 문장까지 모델에 보낼 이유가 없어서다.
 */

import { lookupCity } from './city-table';

export interface City {
  slug: string;
  nameKo: string;
  countryKo: string;
}

/**
 * 퀵리플라이 버튼으로 노출할 **예시** 도시.
 *
 * 허용 목록이 아니다. 여기 없는 도시도 전부 검색된다 —
 * 사용자에게 "이런 걸 물어보면 된다"를 보여주는 용도일 뿐이다.
 */
export const CITIES: City[] = [
  { slug: 'osaka', nameKo: '오사카', countryKo: '일본' },
  { slug: 'tokyo', nameKo: '도쿄', countryKo: '일본' },
  { slug: 'fukuoka', nameKo: '후쿠오카', countryKo: '일본' },
];

/**
 * 오픈빌더가 도시를 실어 보낼 수 있는 파라미터 이름.
 *
 * **첫 줄의 `여행도시` 가 실제로 쓰이는 이름이다** — 오픈빌더 커스텀 엔티티는
 * 한국어 이름을 그대로 파라미터 키로 쓴다. 예전에는 영문 이름만 보고 있어서
 * 카카오가 정확히 뽑아준 도시를 통째로 버리고 매번 모델에 다시 물었다.
 * 나머지는 엔티티 이름을 바꿨을 때를 위한 여유분이다.
 */
export const CITY_PARAMS = [
  '여행도시',
  '도시',
  '여행지',
  '목적지',
  'city',
  'location',
  'sys_location',
] as const;

export interface ParsedQuery {
  /** 캐시 키·DB 에 쓰는 식별자. 모델이 정규화해준 영문 슬러그 (osaka, bangkok, new-york). */
  citySlug: string | null;
  /** 사용자에게 보여줄 한국어 도시명. 오타는 교정된 상태. */
  cityName: string | null;
  guests: number | null;
  nights: number | null;
}

export const EMPTY_QUERY: ParsedQuery = {
  citySlug: null,
  cityName: null,
  guests: null,
  nights: null,
};

export const hasCity = (p: ParsedQuery): boolean => p.citySlug !== null;

/**
 * 슬러그 정규화.
 *
 * 모델이 'New York' 이나 'Osaka' 처럼 줘도, 엔티티가 '동경' 을 줘도 캐시 키가
 * 갈리지 않게 한다. 사전에 없는 도시는 한글이 오면 한글 그대로 둔다 — text 컬럼이라
 * 문제없고, 어차피 모델이 영문 슬러그를 주도록 스키마에 명시돼 있다.
 */
export function citySlugOf(name: string): string {
  // 사전에 있는 도시는 사전 슬러그가 정답이다. 이게 없으면 같은 도시가
  // 경로마다 다른 키로 캐시된다 — 엔티티 경로는 '도쿄', 모델 경로는 'tokyo'.
  const known = lookupCity(name);
  if (known) return known.slug;

  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '');
}

/** 발화를 별칭 캐시 키로 만든다. 띄어쓰기·문장부호 차이는 같은 키로 본다. */
export function utteranceKeyOf(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 200);
}

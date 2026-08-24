/**
 * 발화 파싱의 자료구조.
 *
 * 실제 파싱은 [nlu.service.ts](./nlu.service.ts) 가 gpt-5-mini 로 한다.
 * 예전에는 여기서 도시 별칭 테이블 매칭 + 불용어 블랙리스트 + 조사 제거로 처리했는데,
 * 카카오 사용자는 "오사카 여행갈건데 4명기준으로 숙소 추천해줘" 처럼 말하고 오타도 낸다.
 * 키워드 매칭으로는 감당이 안 되고, 아는 도시 3개만 특별대우하는 것도 앞뒤가 안 맞았다.
 */

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
 * 모델이 'New York' 이나 'Osaka' 처럼 줘도 캐시 키가 갈리지 않게 한다.
 * 한글이 오면 한글 그대로 둔다 — text 컬럼이라 문제없고, 어차피 모델이
 * 영문 슬러그를 주도록 스키마에 명시돼 있다.
 */
export function citySlugOf(name: string): string {
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

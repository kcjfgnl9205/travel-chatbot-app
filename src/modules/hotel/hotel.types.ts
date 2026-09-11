import { CacheKeyPart } from '../search-cache/search-cache.service';

/** provider 가 돌려주는 호텔 1건. 어떤 provider(AI/크롤링/고정)든 이 형태로 맞춘다. */
export interface Hotel {
  name: string;
  citySlug: string;
  /**
   * AI/크롤링이 찾아낸 원본 호텔 주소(아고다/부킹 등).
   * 이 주소를 애드픽 API 로 변환해서 사용자에게 보여준다.
   * 호텔 마스터 테이블이 없으므로 이게 호텔의 유일한 신원이다.
   */
  sourceUrl: string;
  merchant?: string | null; // agoda | booking | ...
  source?: string; // ai | crawler | manual
  sourceRef?: string | null; // 원본 소스의 ID (있으면)
  raw?: Record<string, unknown> | null;

  address?: string | null;
  starRating?: number | null;
  reviewScore?: number | null;
  priceFrom?: number | null;
  currency?: string;
  thumbnailUrl?: string | null;
  description?: string | null;
  tags?: string[];
}

export interface HotelQuery {
  citySlug: string;
  cityName: string;
  checkIn?: string | null;
  checkOut?: string | null;
  guests?: number | null;
  limit: number;
}

/**
 * 캐시 키에 들어가는 조건들.
 *
 * ⚠️ **결과를 갈라야 하는 조건은 여기 다 있어야 한다.** 빠뜨리면 다른 조건으로 물은
 *    사람에게 남의 검색 결과가 나간다.
 */
export function hotelCacheKey(query: HotelQuery): CacheKeyPart[] {
  return [
    query.citySlug,
    query.guests,
    query.checkIn,
    query.checkOut,
    query.limit,
  ];
}

/** 캐시에서 살려낸 값이 호텔 모양인가. 배포로 필드가 바뀌면 미스로 떨어뜨린다. */
export function isHotel(item: unknown): item is Hotel {
  if (!item || typeof item !== 'object') return false;
  const h = item as Hotel;
  return typeof h.name === 'string' && typeof h.sourceUrl === 'string';
}

export function priceText(h: Hotel): string {
  if (!h.priceFrom) return '가격 문의';
  return `1박 ${h.priceFrom.toLocaleString('ko-KR')}원~`;
}

/**
 * 평점 표기.
 *
 * JS 는 9.0 을 "9" 로 찍지만 파이썬 float 은 "9.0" 으로 찍는다.
 * 소수점 한 자리를 유지해야 "평점 9.0 / 평점 8.9" 처럼 폭이 고르게 보이고,
 * 파이썬판과 문자열이 정확히 같아져서 전환 중에 사용자 화면이 바뀌지 않는다.
 */
export function scoreText(score: number): string {
  return Number.isInteger(score) ? score.toFixed(1) : String(score);
}

/**
 * listCard 한 줄 설명. 1줄이라 가격·평점·지역만 압축해서 넣는다.
 * AI/크롤링 결과는 필드가 비어 올 수 있으므로 있는 것만 이어 붙인다.
 */
export function listDescription(h: Hotel): string {
  const bits: string[] = [priceText(h)];
  if (h.reviewScore) bits.push(`평점 ${scoreText(h.reviewScore)}`);
  if (h.tags?.length) bits.push(h.tags[0]);
  return bits.join(' · ');
}

export interface HotelProvider {
  readonly name: string;
  /**
   * ⚠️ 느릴 수 있다(AI provider 는 7~30초). 호출부는 반드시 백그라운드에서만 부른다.
   * 카카오 5초 예산 안에서 도는 건 캐시 조회뿐이다.
   */
  search(query: HotelQuery): Promise<Hotel[]>;
}

/**
 * provider DI 토큰.
 *
 * 구현을 직접 주입하지 않는 이유: 테스트에서 가짜 provider 로 갈아끼워야 하고
 * (실제 OpenAI 를 부르면 안 된다), HOTEL_PROVIDER 설정으로도 바뀐다.
 */
export const HOTEL_PROVIDER = 'HOTEL_PROVIDER';

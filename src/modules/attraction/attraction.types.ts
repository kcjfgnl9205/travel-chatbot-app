import { CacheKeyPart } from '../search-cache/search-cache.service';

/**
 * provider 가 돌려주는 관광지 1건.
 *
 * 호텔·항공권과 달리 **예약 주소가 없다.** 관광지는 파는 물건이 아니라 장소다.
 * 그래서 이 타입에는 sourceUrl 도 merchant 도 없고, 대신 우리가 만든 지도 링크
 * (`mapUrl`)가 유일한 바깥 링크다.
 */
export interface Attraction {
  name: string; // 오사카성
  /**
   * 영문·현지 공식명 (Osaka Castle). 카드에는 안 쓴다.
   *
   * **위키백과 영어판을 검색하려고 받는다.** 한국어 문서가 없는 관광지가 동남아에
   * 특히 많은데(세부는 실측 0/5), 영문명이 있으면 영어판에서 사진을 찾을 수 있다.
   * 이 필드 하나로 사진 커버리지가 62% → 87% 가 됐다.
   */
  nameEn?: string | null;
  citySlug: string;
  /** 역사/문화 · 자연 · 테마파크 · 거리/쇼핑 · 전망 · 미술관/박물관 · 음식 */
  category?: string | null;
  /** 도시 안에서의 위치. 카드 설명에 들어간다 (주오구, 우메다). */
  area?: string | null;
  /** 한 줄 소개. 40자 제한이 있으므로 길어도 잘린다. */
  description?: string | null;

  /** 입장료가 없는 곳인가. 관광지의 절반은 무료다 — 카드 문구가 갈린다. */
  free?: boolean | null;
  /**
   * 성인 1인 입장료. **현지 통화 그대로다.**
   *
   * ⚠️ 원화 환산을 모델에게 시키지 않는다. 실제로 시켜봤더니 1,200엔짜리 오사카성이
   *    '5,760원', 2,700엔짜리 카이유칸이 '2,700원' 으로 나왔다 — 환율을 모른 채
   *    현지 통화 숫자를 원화 칸에 그대로 넣거나 엉뚱하게 곱한 결과다.
   *    **틀린 가격은 없는 가격보다 나쁘다.** 2,700원인 줄 알고 갔다가 27,000원을 낸다.
   *
   *    검색 결과에 적힌 숫자를 그대로 옮기는 건 모델이 잘한다. 환율 계산은 못한다.
   *    (환산이 필요해지면 환율 API 를 붙여 우리가 계산해야 한다)
   */
  admissionFee?: number | null;
  /** 입장료의 통화 (ISO 4217: JPY, KRW, THB …). 금액이 있으면 이것도 있어야 한다. */
  admissionCurrency?: string | null;
  /** 둘러보는 데 걸리는 시간(분). 일정을 짜려면 이게 가격보다 중요하다. */
  durationMinutes?: number | null;

  /**
   * 구글맵 링크. **모델이 준 게 아니라 [maps-url.ts](../../common/maps-url.ts) 가 만든다.**
   *
   * 관광지에는 예약 페이지가 없으므로 이게 항목의 신원 역할도 겸한다 —
   * 이름+도시로 결정되는 값이라 같은 관광지는 항상 같은 URL 이 된다.
   */
  mapUrl: string;

  /**
   * 카드 썸네일. 위키백과에서 찾는다([attraction-image.ts](./attraction-image.ts)).
   *
   * ⚠️ **없을 수 있다.** 사진이 있는 관광지가 열에 아홉은 아니다(실측 87%).
   *    없으면 그 줄만 사진 없이 나간다 — 호텔도 썸네일을 못 구하면 같은 모양이다.
   *    사진을 못 구했다고 관광지를 목록에서 빼지는 않는다.
   */
  imageUrl?: string | null;

  source?: string; // ai | crawler | manual
  tags?: string[];
  raw?: Record<string, unknown> | null;
}

export interface AttractionQuery {
  citySlug: string;
  cityName: string;
  limit: number;
}

/** 캐시 키에 들어가는 조건들. 관광지는 도시 하나가 전부다. */
export function attractionCacheKey(query: AttractionQuery): CacheKeyPart[] {
  return [query.citySlug, query.limit];
}

/** 캐시에서 살려낸 값이 관광지 모양인가. 배포로 필드가 바뀌면 미스로 떨어뜨린다. */
export function isAttraction(item: unknown): item is Attraction {
  if (!item || typeof item !== 'object') return false;
  const a = item as Attraction;
  return typeof a.name === 'string' && typeof a.mapUrl === 'string';
}

/**
 * 같은 관광지인지 판정하는 키.
 *
 * 이름은 못 믿는다 — 모델이 '오사카성' / '오사카 성' / 'Osaka Castle' 을 섞어 준다.
 * mapUrl 은 이름을 정규화해서 만든 값이라 표기 흔들림을 어느 정도 흡수하고,
 * 무엇보다 **사용자가 실제로 도착하는 곳**이 같으면 같은 관광지다.
 */
export function attractionKey(a: Attraction): string {
  return a.mapUrl;
}

// ------------------------------------------------------------------ 카드 문구
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
 * 환산하지 않는다 — 위 주석 참고.
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

/** 150 → '2시간 30분'. 60분 미만이면 분만. */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
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

export interface AttractionProvider {
  readonly name: string;
  /**
   * ⚠️ 느릴 수 있다(AI provider 는 7~30초). 호출부는 반드시 백그라운드에서만 부른다.
   * 카카오 5초 예산 안에서 도는 건 캐시 조회뿐이다.
   */
  search(query: AttractionQuery): Promise<Attraction[]>;
}

/**
 * provider DI 토큰.
 *
 * 구현을 직접 주입하지 않는 이유: 테스트에서 가짜 provider 로 갈아끼워야 하고
 * (실제 OpenAI 를 부르면 안 된다), ATTRACTION_PROVIDER 설정으로도 바뀐다.
 */
export const ATTRACTION_PROVIDER = 'ATTRACTION_PROVIDER';

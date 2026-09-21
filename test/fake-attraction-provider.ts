import { mapsUrl } from '../src/common/maps-url';
import {
  Attraction,
  AttractionProvider,
  AttractionQuery,
} from '../src/modules/attraction/attraction.types';

/**
 * 테스트용 관광지 provider.
 *
 * 진짜 OpenAiAttractionProvider 를 그대로 두면 테스트가 실제 API 를 때리고 요금이 나간다.
 * ATTRACTION_PROVIDER 토큰을 이걸로 덮어써서 검색 결과를 우리가 정한다.
 */
export class FakeAttractionProvider implements AttractionProvider {
  readonly name = 'fake';

  /** 어떤 쿼리로 몇 번 불렸는지. 캐시·중복 호출 방지 검증에 쓴다. */
  readonly calls: AttractionQuery[] = [];
  /** AI 검색이 느린 상황을 흉내 낼 때. */
  delayMs = 0;
  /** 특정 테스트에서 결과를 갈아끼울 때. */
  reply: (query: AttractionQuery) => Attraction[] = defaultAttractions;

  async search(query: AttractionQuery): Promise<Attraction[]> {
    this.calls.push(query);
    if (this.delayMs) await sleep(this.delayMs);
    return this.reply(query);
  }

  reset(): void {
    this.calls.length = 0;
    this.delayMs = 0;
    this.reply = defaultAttractions;
  }
}

/**
 * 느린 검색 흉내.
 *
 * unref() 하지 않으면 테스트가 끝나도 이 타이머가 워커를 붙잡아
 * "worker process has failed to exit gracefully" 가 뜬다.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * [이름, 카테고리, 지역, 무료인가, 입장료(현지 통화), 소요(분)]
 *
 * 금액은 **환산하지 않은 현지 통화**다 (일본이라 JPY). 진짜 provider 도 그렇게 준다 —
 * 모델에게 환율 계산을 시키면 틀린 가격이 카드에 찍힌다.
 */
const SPOTS: [string, string, string, number | null, number | null][] = [
  ['테스트성', '역사/문화', '주오구', 4.4, 61234],
  ['테스트 거리', '거리/쇼핑', '난바', 4.2, 30120],
  ['테스트 전망대', '관광명소', '우메다', 4.5, 21000],
  ['테스트 공원', '자연/공원', '기타구', 4.1, 8300],
  ['테스트 수족관', '테마파크', '미나토구', 4.3, 45000],
  ['테스트 시장', '거리/쇼핑', '난바', null, null],
];

/**
 * 사진이 **일부만** 채워진다 (6곳 중 4곳).
 *
 * 진짜 provider 도 그렇다 — 위키미디어에 사진이 없는 관광지가 있다. 전부 채워 두면
 * "사진 없는 줄이 섞여도 카드가 나간다" 를 테스트가 못 잡는다.
 */
const NO_IMAGE = new Set(['테스트 공원', '테스트 시장']);

/** 5줄 제한을 넘겨서 자르기까지 검증되도록 6곳을 준다. */
export function defaultAttractions(query: AttractionQuery): Attraction[] {
  return SPOTS.map(([name, category, area, rating, reviews], index) => {
    const fullName = `${query.cityName} ${name}`;
    // 진짜 provider 처럼 구글 신원이 있다고 본다. 지도 링크도 그걸로 만든다.
    const placeId = `ChIJ_${query.citySlug}_${index}`;
    return {
      placeId,
      name: fullName,
      nameEn: `${query.citySlug} ${name}`,
      citySlug: query.citySlug,
      category,
      area,
      address: `${query.cityName} ${area} 1-1`,
      lat: 34.6 + index / 100,
      lng: 135.5 + index / 100,
      rating,
      userRatingCount: reviews,
      mapUrl: mapsUrl(fullName, query.cityName, placeId),
      imageUrl: NO_IMAGE.has(name)
        ? null
        : `https://upload.wikimedia.org/wikipedia/commons/a/a1/${encodeURIComponent(name)}.jpg`,
    };
  });
}

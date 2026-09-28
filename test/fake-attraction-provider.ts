import { mapsUrl } from '../src/common/maps-url';
import {
  Attraction,
  AttractionProvider,
  AttractionQuery,
} from '../src/modules/attraction/attraction.types';

/**
 * 테스트용 관광지 provider.
 *
 * 진짜 DbAttractionProvider 를 그대로 두면 테스트가 Supabase 를 찾는다.
 * ATTRACTION_PROVIDER 토큰을 이걸로 덮어써서 조회 결과를 우리가 정한다.
 */
export class FakeAttractionProvider implements AttractionProvider {
  readonly name = 'fake';

  /** 어떤 쿼리로 몇 번 불렸는지. 캐시·중복 호출 방지 검증에 쓴다. */
  readonly calls: AttractionQuery[] = [];
  /** DB 가 느린 상황을 흉내 낼 때. */
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
 * [이름, 지역]
 *
 * **0009 부터 이게 전부다.** 평점·카테고리·입장료·좌표는 전부 남의 콘텐츠라
 * 같이 걷어냈다 — 관리 화면에서 사람이 넣는 칸만 남는다.
 */
const SPOTS: [string, string][] = [
  ['테스트성', '주오구'],
  ['테스트 거리', '난바'],
  ['테스트 전망대', '우메다'],
  ['테스트 공원', '기타구'],
  ['테스트 수족관', '미나토구'],
  ['테스트 시장', '난바'],
];

/**
 * 사진이 **일부만** 채워진다 (6곳 중 4곳).
 *
 * 관리 화면에서 사진을 안 넣은 곳이 있기 마련이다. 전부 채워 두면 "사진 없는 줄이
 * 섞여도 카드가 나간다" 를 테스트가 못 잡는다.
 */
const NO_IMAGE = new Set(['테스트 공원', '테스트 시장']);

/** 5줄 제한을 넘겨서 자르기까지 검증되도록 6곳을 준다. */
export function defaultAttractions(query: AttractionQuery): Attraction[] {
  return SPOTS.map(([name, area], index) => {
    const fullName = `${query.cityName} ${name}`;
    return {
      // 진짜 provider 처럼 DB 신원이 있다고 본다. 도시마다 달라야 캐시 키 테스트가 산다.
      id: query.cityId * 100 + index,
      name: fullName,
      citySlug: query.citySlug,
      area,
      mapUrl: mapsUrl(fullName, query.cityName),
      imageUrl: NO_IMAGE.has(name)
        ? null
        : `https://cdn.example.com/${encodeURIComponent(name)}.jpg`,
    };
  });
}

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
const SPOTS: [string, string, string, boolean, number | null, number][] = [
  ['테스트성', '역사/문화', '주오구', false, 1200, 120],
  ['테스트 거리', '거리/쇼핑', '난바', true, null, 120],
  ['테스트 전망대', '전망', '우메다', false, 1500, 60],
  ['테스트 공원', '자연/공원', '기타구', true, null, 90],
  ['테스트 수족관', '테마파크', '미나토구', false, 2700, 180],
  ['테스트 시장', '음식/시장', '난바', true, null, 60],
];

/** 5줄 제한을 넘겨서 자르기까지 검증되도록 6곳을 준다. */
export function defaultAttractions(query: AttractionQuery): Attraction[] {
  return SPOTS.map(([name, category, area, free, fee, minutes]) => ({
    name: `${query.cityName} ${name}`,
    citySlug: query.citySlug,
    category,
    area,
    description: '테스트용 관광지',
    free,
    admissionFee: fee,
    admissionCurrency: fee ? 'JPY' : null,
    durationMinutes: minutes,
    // provider 가 직접 만든다 — 실제 provider 와 같은 방식이라야 링크 검증이 의미 있다.
    mapUrl: mapsUrl(`${query.cityName} ${name}`, query.cityName),
    source: 'ai',
    tags: ['테스트'],
  }));
}

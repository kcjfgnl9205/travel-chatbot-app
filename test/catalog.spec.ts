import { SEED_CITY_COUNT, seedCities } from '../src/modules/catalog/catalog.service';
import { CITY_TABLE } from '../src/modules/places/city-table';

/**
 * 미리 채워둘 도시.
 *
 * **경계를 테스트로 박아둔다.** 사전([city-table.ts])은 지역별로 묶여 있고 씨앗은 그
 * 경계를 그대로 쓰는데, 목록이 슬라이스라서 **중간에 도시를 하나 끼우면 경계가
 * 소리 없이 밀린다.** 그러면 유럽 도시가 씨앗에 들어오거나 중화권 도시가 빠진다.
 */
describe('씨앗 도시', () => {
  it('아시아(일본·한국·동남아·중화권)까지다', () => {
    const cities = seedCities();

    expect(cities).toHaveLength(SEED_CITY_COUNT);
    // 경계 양쪽을 박아둔다 — 사전 순서가 바뀌면 여기서 걸린다.
    expect(cities[cities.length - 1].nameKo).toBe('하얼빈');
    expect(CITY_TABLE[SEED_CITY_COUNT].nameKo).toBe('파리');
  });

  /** 씨앗에 없다고 막히는 건 아니다. 누가 물으면 그 자리에서 찾고 배치 대상이 된다. */
  it('나머지 도시는 사전에 그대로 남는다', () => {
    expect(CITY_TABLE.length).toBeGreaterThan(SEED_CITY_COUNT);
  });
});

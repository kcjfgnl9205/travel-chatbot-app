import { CatalogService } from '../src/modules/catalog/catalog.service';
import { Place } from '../src/modules/places/places.types';

/**
 * 씨앗이 **한 곳씩 순차로 돌지 않는가.**
 *
 * ⚠️ 운영에서 504 로 드러난 사고다. 도시마다 DB 왕복이 두 번이라 112곳을 순차로
 *    돌면 프록시 타임아웃(100초)을 넘긴다.
 *
 * 갱신 배치 검증은 0009 에서 같이 사라졌다 — 관광지 목록이 우리 DB 로 오면서
 * 미리 채울 것이 없어졌고, `startRefresh` 도 없어졌다.
 */

function city(id: number, name: string): Place {
  return { id, canonicalName: name, slug: `c${id}`, kind: 'city', countryCode: null, iata: null, parentId: null };
}

function build(over: {
  resolve?: (name: string) => Promise<Place | null>;
  stored?: number | null;
} = {}) {
  const places = {
    resolve: over.resolve ?? (async (name: string) => city(1, name)),
  } as never;
  const placesRepo = {
    countCities: async () => ('stored' in over ? over.stored : 0),
  } as never;

  return { service: new CatalogService(places, placesRepo) };
}

describe('씨앗 등록', () => {
  it('한 곳씩 순차로 돌지 않는다 — 112곳이면 타임아웃이다', async () => {
    let running = 0;
    let peak = 0;
    const { service } = build({
      resolve: async (name) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1));
        running -= 1;
        return city(1, name);
      },
    });

    const { seeded } = await service.seed();

    expect(seeded).toBeGreaterThan(100);
    // 동시에 여러 곳이 돌아야 한다. 1이면 순차라 그때 그 사고가 다시 난다.
    expect(peak).toBeGreaterThan(1);
  });

  /** ⚠️ 한꺼번에 다 던지면 DB 연결을 112개 잡는다. 그 사이를 지킨다. */
  it('그렇다고 한꺼번에 다 던지지도 않는다', async () => {
    let running = 0;
    let peak = 0;
    const { service } = build({
      resolve: async (name) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1));
        running -= 1;
        return city(1, name);
      },
    });

    await service.seed();

    expect(peak).toBeLessThanOrEqual(8);
  });

  it('등록 실패한 도시는 세지 않는다', async () => {
    const { service } = build({ resolve: async () => null });

    expect((await service.seed()).seeded).toBe(0);
  });

  /**
   * ⚠️ **운영에서 한 시간을 잃은 자리다.** 지역 해석은 DB 가 꺼져 있어도 메모리로
   *    폴백해서 Place 를 돌려준다(지명 인식이 DB 장애로 멈추면 안 되니까). 그래서
   *    DB 가 통째로 안 잡힌 상태에서도 "112곳 완료" 가 나왔고, 응답만으로는 아무도
   *    몰랐다. 실제로 심겼는지는 DB 를 세어봐야 안다.
   */
  it('DB 에 안 들어갔으면 stored 로 드러난다', async () => {
    const { service } = build({ stored: 0 });

    const result = await service.seed();

    expect(result.seeded).toBeGreaterThan(100);
    expect(result.stored).toBe(0);
  });

  it('DB 가 꺼져 있으면 stored 가 null 이다', async () => {
    const { service } = build({ stored: null });

    expect((await service.seed()).stored).toBeNull();
  });
});

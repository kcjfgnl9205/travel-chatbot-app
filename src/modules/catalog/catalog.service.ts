import { Injectable, Logger } from '@nestjs/common';

import { PlacesRepository } from '../database/repositories/places.repository';
import { CITY_TABLE } from '../places/city-table';
import { PlacesService } from '../places/places.service';

/**
 * 씨앗 도시를 `places` 에 심는다.
 *
 * **0009 에서 배치가 없어지고 이것만 남았다.** 예전에는 도시마다 구글에 관광지를
 * 물어 캐시를 데워두는 배치가 있었는데, 목록이 우리 DB 로 오면서 미리 채울 것이
 * 사라졌다 — 질문이 오면 그 자리에서 읽는다.
 *
 * 그래도 씨앗은 남는다. `places` 는 원래 "쓰면서 자라는" 테이블이라 아무도 안 물은
 * 도시는 행이 없는데, **관리 화면에서 관광지를 넣으려면 도시 행이 먼저 있어야 한다.**
 * 빈 드롭다운을 보여주지 않으려면 미리 심어두는 편이 낫다.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly places: PlacesService,
    private readonly placesRepo: PlacesRepository,
  ) {}

  /**
   * 씨앗 도시를 `places` 에 등록한다. **한 번만 부르면 된다.**
   *
   * **모델을 부르지 않는다** — 사전에 있는 도시는 표준명이 이미 있다.
   */
  async seed(): Promise<{ seeded: number; stored: number | null }> {
    // ⚠️ **한 곳씩 순차로 돌리면 안 된다.** 도시마다 DB 왕복이 두 번(별칭 조회 +
    //    upsert)이라 112곳이면 224번이고, 그게 프록시 타임아웃(100초)을 넘겼다.
    //    도시끼리는 서로를 모르므로 나눠 돌려도 결과가 같다.
    const results = await inBatches(seedCities(), SEED_CONCURRENCY, (city) =>
      this.places.resolve(city.nameKo),
    );
    const seeded = results.filter(Boolean).length;

    // ⚠️ **seeded 만으로는 심겼는지 알 수 없다.** 지역 해석은 DB 가 꺼져 있거나
    //    흔들려도 계속돼야 해서(지명 인식이 DB 장애로 멈추면 안 된다) 메모리로
    //    폴백하고 Place 를 돌려준다 — 그래서 DB 가 통째로 안 잡힌 상태에서도
    //    "112곳 완료" 가 나온다. 실제로 그렇게 한 시간을 잃었다.
    //    그래서 DB 를 직접 세서 같이 돌려준다. stored 가 0 이면 자격증명 문제다.
    const stored = await this.placesRepo.countCities();
    this.logger.log(`seeded cities=${seeded}/${results.length} stored=${stored ?? 'DB 꺼짐'}`);
    return { seeded, stored };
  }
}

/** 씨앗 등록 동시 실행 수. DB 를 두들기지 않으면서 112곳이 10초대에 끝나는 선. */
const SEED_CONCURRENCY = 8;

/**
 * 몇 개씩 나눠 돌린다.
 *
 * Promise.all 로 112개를 한꺼번에 던지면 DB 연결을 그만큼 잡는다. 순차로 돌리면
 * 타임아웃이 난다. 그 사이를 고른다.
 */
async function inBatches<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return out;
}

/**
 * 미리 심어둘 도시.
 *
 * **아시아(일본·한국·동남아·중화권)까지다.** 한국인 여행 수요가 여기 몰려 있고,
 * 유럽·미주는 같은 노력 대비 적중률이 낮다. 사전([city-table.ts](../places/city-table.ts))이 지역별로 묶여
 * 있으므로 그 경계를 그대로 쓴다 — 목록을 따로 손으로 관리하면 사전과 어긋난다.
 *
 * 나머지 도시가 막히는 건 아니다. 관리 API 에 "파리" 로 관광지를 넣으면 그때
 * `places` 행이 생긴다.
 */
export function seedCities(): typeof CITY_TABLE {
  return CITY_TABLE.slice(0, SEED_CITY_COUNT);
}

/** 일본 36 + 한국 21 + 동남아 37 + 중화권 18. 사전의 지역 경계와 같다. */
export const SEED_CITY_COUNT = 112;

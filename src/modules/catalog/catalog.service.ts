import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import { PlacesRepository } from '../database/repositories/places.repository';
import { SearchResultsRepository } from '../database/repositories/search-results.repository';
import { CITY_TABLE } from '../places/city-table';
import { PlacesService } from '../places/places.service';
import { Place } from '../places/places.types';
import { SearchService } from '../search/search.service';
import { isAttraction } from '../attraction/attraction.types';

/**
 * 도시별 관광지 목록을 **미리 채워두는 배치.**
 *
 * **왜 미리 채우나** — 지금은 처음 묻는 도시면 "찾고 있어요" 를 보내고 7~30초 뒤에
 * 콜백으로 카드가 간다. 미리 채워두면 **첫 질문부터 카드가 즉시** 나간다.
 * 사용자 체감이 가장 크게 바뀌는 지점이다.
 *
 * ⚠️ **온디맨드 경로를 대체하지 않는다.** 목록에 없는 도시(도톤보리 같은 세부 지역
 *    포함)를 누가 물으면 지금처럼 그 자리에서 찾는다. 이 배치는 "자주 묻는 도시를
 *    미리 데워두는" 역할이고, 배치가 실패해도 검색은 계속 된다.
 *
 * ⚠️ **스케줄러는 여기 없다.** 운영 쪽에서 크론으로 엔드포인트를 때린다 — 서버가
 *    여러 대여도 배치는 하나만 돌아야 하고, 그 판단은 앱이 아니라 운영이 한다.
 *
 * 주기는 **캐시 TTL 보다 짧게**(기본 28일 < 30일). 만료된 뒤에 갱신하면 그 도시의
 * 첫 질문이 다시 대기를 타므로 미리 채워두는 의미가 없어진다.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly places: PlacesService,
    private readonly placesRepo: PlacesRepository,
    private readonly searchResults: SearchResultsRepository,
    private readonly search: SearchService,
  ) {}

  /**
   * 씨앗 도시를 `places` 에 등록한다. **한 번만 부르면 된다.**
   *
   * `places` 는 원래 "쓰면서 자라는" 테이블이라([0004](../../../supabase/migrations/0004_router.sql))
   * 아무도 안 물은 도시는 행이 없다. 미리 채우려면 대상 목록이 있어야 해서 사전에서
   * 씨를 뿌린다. **모델을 부르지 않는다** — 사전에 있는 도시는 표준명이 이미 있다.
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

  /**
   * 갱신할 때가 된 도시들을 채운다. 크론이 하루 한 번 부르는 진입점이다.
   *
   * ⚠️ **한 도시가 실패해도 나머지를 계속한다.** 구글이 잠깐 흔들렸다고 그날 배치가
   *    통째로 멈추면, 다음날까지 그 도시들이 비어 있게 된다.
   */
  async startRefresh(limit: number): Promise<{ started: string[] }> {
    const olderThan = new Date(
      Date.now() - this.config.attractionRefreshDays * 86_400_000,
    );
    const cities = await this.placesRepo.dueForAttractions(olderThan, limit);

    // ⚠️ **응답을 기다리게 하지 않는다.** 도시 하나에 구글 6회 + 모델 2회 + 사진
    //    최대 60회가 돌아 30초~2분이다. 크론은 본문을 읽지 않고, 사람이 부를 때도
    //    진행은 로그로 본다 — 기다리면 프록시 타임아웃(100초)에 걸린다.
    void this.runRefresh(cities);
    return { started: cities.map((city) => city.canonicalName) };
  }

  /** 실제 작업. 요청과 분리돼 돌기 때문에 **여기서 던진 예외는 아무도 못 받는다.** */
  private async runRefresh(
    cities: Place[],
  ): Promise<{ refreshed: string[]; failed: string[] }> {
    const refreshed: string[] = [];
    const failed: string[] = [];
    for (const city of cities) {
      try {
        await this.refreshCity(city);
        refreshed.push(city.canonicalName);
      } catch (err) {
        this.logger.error(
          `refresh failed city=${city.canonicalName} err=${err}`,
        );
        failed.push(city.canonicalName);
      }
    }

    // 만료된 관광지 캐시를 지운다. ⚠️ 구글 콘텐츠라 30일이 지나면 실제로 지워야 한다 —
    // 다른 도메인과 달리 "만료돼도 보여주기" 를 쓰지 않는 이유이기도 하다.
    const purged = await this.searchResults
      .purgeExpired('attraction')
      .catch(() => null);
    this.logger.log(
      `batch done refreshed=${refreshed.length} failed=${failed.length} purged=${purged ?? 0}`,
    );
    return { refreshed, failed };
  }

  /**
   * 도시 하나를 채운다. 검색 경로와 **같은 코드를 태운다** — 배치용 파이프라인을
   * 따로 만들면 그건 실제 응답을 데워두는 게 아니라 비슷한 걸 하나 더 만드는 것이다.
   */
  async refreshCity(city: Place): Promise<number> {
    const items = await this.search.warm('attraction', city);
    const attractions = items.filter(isAttraction);
    if (!attractions.length) {
      // 빈손을 도장 찍지 않는다. 다음 배치가 다시 집어야 한다.
      this.logger.warn(`refresh empty city=${city.canonicalName}`);
      return 0;
    }

    // place_id 목록은 도메인이 저장한다(AttractionService.search) — 사용자가 물어서
    // 찾은 도시와 배치가 찾은 도시가 같은 상태가 되게 하려는 것이다. 여기서 또 쓰면
    // 같은 일을 두 곳에서 하게 된다.
    await this.placesRepo.markAttractionsRefreshed(city.id);
    this.logger.log(
      `refreshed city=${city.canonicalName} places=${attractions.length}`,
    );
    return attractions.length;
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
 * 미리 채워둘 도시.
 *
 * **아시아(일본·한국·동남아·중화권)까지다.** 한국인 여행 수요가 여기 몰려 있고,
 * 유럽·미주는 같은 노력 대비 적중률이 낮다. 사전([city-table.ts](../places/city-table.ts))이 지역별로 묶여
 * 있으므로 그 경계를 그대로 쓴다 — 목록을 따로 손으로 관리하면 사전과 어긋난다.
 *
 * 나머지 도시가 막히는 건 아니다. 누가 물으면 그 자리에서 찾고, 그때부터 배치 대상이
 * 된다 (places 행이 생기기 때문이다).
 */
export function seedCities(): typeof CITY_TABLE {
  return CITY_TABLE.slice(0, SEED_CITY_COUNT);
}

/** 일본 36 + 한국 21 + 동남아 37 + 중화권 18. 사전의 지역 경계와 같다. */
export const SEED_CITY_COUNT = 112;

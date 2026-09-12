import { Test } from '@nestjs/testing';

import { loadConfig } from '../src/config/app.config';
import { AppConfigModule } from '../src/config/config.module';
import { SearchResultsRepository } from '../src/modules/database/repositories/search-results.repository';
import { DatabaseModule } from '../src/modules/database/database.module';
import { SearchStoreService, isExpired } from '../src/modules/search/search-store.service';
import { SearchMeta } from '../src/modules/search/search.types';

/**
 * 선점(single-flight) 검증.
 *
 * DB 가 없는 모드다 — 그래도 **프로세스 안에서는** 한 번만 검색해야 한다.
 * (DB 가 붙으면 서버 여러 대까지 같은 규칙이 확장된다)
 */
describe('SearchStoreService', () => {
  const meta: SearchMeta = { kind: 'hotel', placeName: '오사카', placeSlug: 'osaka' };
  const claim = { cacheKey: 'hotel:1', kind: 'hotel' as const, placeId: 1, fromPlaceId: null, toPlaceId: null, tripType: null, meta };

  let store: SearchStoreService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [SearchStoreService],
    }).compile();

    store = moduleRef.get(SearchStoreService);
    store.clearMemory();
  });

  it('먼저 꽂은 쪽만 검색한다', async () => {
    const results = await Promise.all([
      store.claim(claim, null),
      store.claim(claim, null),
      store.claim(claim, null),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('검색이 끝나면 저장되고 다음 사람은 그걸 받는다', async () => {
    await store.claim(claim, null);
    await store.complete('hotel:1', [{ name: 'A' }], 60, meta);

    const row = await store.get('hotel:1');

    expect(row).toMatchObject({ status: 'ready', items: [{ name: 'A' }] });
    expect(isExpired(row!)).toBe(false);
  });

  it('만료된 행은 다시 검색할 수 있다 — 다만 항목은 지우지 않는다', async () => {
    await store.claim(claim, null);
    await store.complete('hotel:1', [{ name: 'A' }], -1, meta); // 이미 만료된 상태로 저장

    const row = await store.get('hotel:1');
    expect(isExpired(row!)).toBe(true);
    // 예전 결과라도 보여줄 수 있어야 한다. 빈손보다 낫다.
    expect(row!.items).toHaveLength(1);
    expect(await store.claim(claim, row)).toBe(true);
  });

  it('검색 중인 행은 다른 요청이 가져가지 못한다', async () => {
    await store.claim(claim, null);

    const row = await store.get('hotel:1');

    expect(row!.status).toBe('pending');
    expect(store.isBusy(row!)).toBe(true);
    expect(await store.claim(claim, row)).toBe(false);
  });

  it('실패해도 예전 결과는 남는다', async () => {
    await store.claim(claim, null);
    await store.complete('hotel:1', [{ name: 'A' }], 60, meta);
    await store.fail('hotel:1', 'boom', 10, meta);

    const row = await store.get('hotel:1');

    expect(row).toMatchObject({ status: 'failed', error: 'boom' });
    expect(row!.items).toHaveLength(1);
  });

  /**
   * ⚠️ **테이블이 없는 서버에서도 검색은 돼야 한다.**
   *
   * 0004 마이그레이션을 안 돌린 채 배포하면 search_results 쓰기가 전부 실패한다.
   * 그때 "남이 선점했다" 와 똑같이 취급하면 **아무도 검색을 못 하고** 모든 요청이
   * "먼저 찾고 있어요" 로 끝난다 — 겉보기엔 봇이 멀쩡히 살아 있으므로 원인을
   * 찾기까지 오래 걸린다. DB 를 못 믿을 때는 메모리 선점만으로 진행한다.
   */
  describe('DB 를 못 쓸 때', () => {
    const brokenRepo = {
      enabled: true,
      get: async () => null,
      claim: async () => null,
      reclaim: async () => null,
      complete: async () => undefined,
      fail: async () => undefined,
    } as unknown as SearchResultsRepository;

    it('테이블이 없어도 검색을 진행한다', async () => {
      const broken = new SearchStoreService(loadConfig(), brokenRepo);

      expect(await broken.claim(claim, null)).toBe(true);
    });

    it('그래도 같은 프로세스 안에서는 한 번만 검색한다', async () => {
      const broken = new SearchStoreService(loadConfig(), brokenRepo);

      const results = await Promise.all([
        broken.claim(claim, null),
        broken.claim(claim, null),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('결과는 메모리에 남아 다음 사람에게 나간다', async () => {
      const broken = new SearchStoreService(loadConfig(), brokenRepo);
      await broken.claim(claim, null);
      await broken.complete('hotel:1', [{ name: 'A' }], 60, meta);

      expect(await broken.get('hotel:1')).toMatchObject({ status: 'ready' });
    });
  });
});

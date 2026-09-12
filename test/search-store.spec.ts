import { Test } from '@nestjs/testing';

import { AppConfigModule } from '../src/config/config.module';
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
});

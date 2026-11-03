import { join } from 'node:path';

import { createConnection } from 'mysql2/promise';

import { AppConfig, loadConfig } from '../src/config/app.config';
import { MYSQL_POOL_DEFAULTS, MysqlService } from '../src/modules/database/mysql.service';
import { AffiliateLinksRepository } from '../src/modules/database/repositories/affiliate-links.repository';
import { AttractionsRepository } from '../src/modules/database/repositories/attractions.repository';
import { IntentCacheRepository } from '../src/modules/database/repositories/intent-cache.repository';
import { MessagesRepository } from '../src/modules/database/repositories/messages.repository';
import {
  PlaceAliasesRepository,
  PlacesRepository,
} from '../src/modules/database/repositories/places.repository';
import {
  RecommendationItemsRepository,
  RecommendationsRepository,
} from '../src/modules/database/repositories/recommendations.repository';
import { SearchResultsRepository } from '../src/modules/database/repositories/search-results.repository';
import { UsersRepository } from '../src/modules/database/repositories/users.repository';
import { PlaceDraft } from '../src/modules/places/places.types';
import { SearchMeta } from '../src/modules/search/search.types';
import { runMigrations } from '../src/migrate';

/**
 * **진짜 MySQL 에 대고** 레포지토리를 돌린다.
 *
 * 다른 테스트는 전부 DB 없는 no-op 모드라, SQL 이 틀려도(예약어 `rank`, 시간대,
 * 중복 무시 판정) 통과한다. 그런 건 실제 서버에서만 드러난다.
 *
 * MYSQL_TEST_HOST 가 있을 때만 돈다. ⚠️ **테스트 DB 를 통째로 비운다** — 운영 DB 를
 * 가리키지 마라. 로컬에서:
 *
 *   MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT=3307 MYSQL_TEST_USER=root \
 *   MYSQL_TEST_DATABASE=gajago_test npx jest mysql-repositories
 */
const HOST = process.env.MYSQL_TEST_HOST;
const suite = HOST ? describe : describe.skip;

suite('MySQL 레포지토리 (통합)', () => {
  const database = process.env.MYSQL_TEST_DATABASE ?? 'gajago_test';
  const config: AppConfig = {
    ...loadConfig(),
    mysqlHost: HOST ?? '',
    mysqlPort: Number(process.env.MYSQL_TEST_PORT ?? 3306),
    mysqlUser: process.env.MYSQL_TEST_USER ?? 'root',
    mysqlPassword: process.env.MYSQL_TEST_PASSWORD ?? '',
    mysqlDatabase: database,
    mysqlPoolSize: 5,
  };
  const db = new MysqlService(config);

  const users = new UsersRepository(db);
  const messages = new MessagesRepository(db);
  const recs = new RecommendationsRepository(db);
  const items = new RecommendationItemsRepository(db);
  const links = new AffiliateLinksRepository(db);
  const intents = new IntentCacheRepository(db);
  const places = new PlacesRepository(db);
  const aliases = new PlaceAliasesRepository(db);
  const search = new SearchResultsRepository(db);
  const attractions = new AttractionsRepository(db);

  const quiet = { log: () => undefined, warn: () => undefined };

  beforeAll(async () => {
    const conn = await createConnection({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: config.mysqlUser,
      password: config.mysqlPassword,
      ...MYSQL_POOL_DEFAULTS,
    });
    await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await conn.query(`CREATE DATABASE \`${database}\``);
    await conn.query(`USE \`${database}\``);
    await runMigrations(conn, join(__dirname, '../db/mysql'), quiet);
    await conn.end();
  });

  afterAll(() => db.onModuleDestroy());

  const draft = (over: Partial<PlaceDraft>): PlaceDraft => ({
    canonicalName: '오사카',
    slug: 'osaka',
    countryCode: 'JP',
    kind: 'city',
    iata: 'KIX',
    parentId: null,
    rank: null,
    blurb: null,
    ...over,
  });

  // ------------------------------------------------------------ 마이그레이션
  it('마이그레이션을 다시 돌리면 아무것도 안 한다', async () => {
    const conn = await createConnection({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: config.mysqlUser,
      password: config.mysqlPassword,
      database,
      ...MYSQL_POOL_DEFAULTS,
    });
    expect(await runMigrations(conn, join(__dirname, '../db/mysql'), quiet)).toBe(0);
    await conn.end();
  });

  // ------------------------------------------------------------ 사용자
  it('같은 사람은 같은 행, 대소문자가 다르면 다른 사람이다', async () => {
    const a = await users.getOrCreate('UserKey');
    users.clearMemory();
    const again = await users.getOrCreate('UserKey');
    const other = await users.getOrCreate('userkey');
    expect(a?.id).toBeTruthy();
    expect(again?.id).toBe(a?.id);
    expect(other?.id).not.toBe(a?.id);
    expect(a?.first_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('시각은 UTC 로 들어간다 — 기본값(CURRENT_TIMESTAMP)도 지금 시각과 맞는다', async () => {
    const before = Date.now();
    users.clearMemory();
    const row = await users.getOrCreate(`tz-${before}`);
    const at = Date.parse(String(row?.first_seen_at));
    expect(Math.abs(at - before)).toBeLessThan(5_000);
  });

  // ------------------------------------------------------------ 노출·클릭
  it('메시지 → 노출 → 줄을 남기고, 클릭이 카운터를 올리며 목적지를 돌려준다', async () => {
    const user = await users.getOrCreate('clicker');
    const msg = await messages.log({
      userId: user!.id,
      domain: 'hotel',
      utterance: '오사카 호텔',
      params: { a: 1 },
      rawPayload: { nested: { ok: true } },
    });
    const rec = await recs.create({
      userId: user!.id,
      messageId: msg!.id,
      domain: 'hotel',
      citySlug: 'osaka',
      provider: 'ai',
      itemCount: 1,
      cacheHit: true,
    });
    const saved = await items.createMany([
      {
        recommendation_id: rec!.id,
        domain: 'hotel',
        position: 0,
        click_id: 'click-1',
        target_url: 'https://example.com/h/1',
        source_url: 'https://example.com/h/1',
        item_name: '호텔 하나',
        price: 120000,
        merchant: 'agoda',
        image_url: null,
        affiliate_link_id: null,
      },
    ]);
    expect(saved).toHaveLength(1);

    const first = await items.registerClick('click-1');
    const second = await items.registerClick('click-1');
    expect(first).toEqual({
      target_url: 'https://example.com/h/1',
      source_url: 'https://example.com/h/1',
      merchant: 'agoda',
      recommendation_id: rec!.id,
      item_name: '호텔 하나',
      click_count: 1,
    });
    expect(second?.click_count).toBe(2);
    expect(await items.registerClick('nope')).toBeNull();
  });

  it('없는 부모를 문 줄은 실패(null)로 돌아온다 — 조용히 삼키지 않는다', async () => {
    const res = await items.createMany([
      {
        recommendation_id: '00000000-0000-0000-0000-000000000000',
        click_id: 'orphan',
        target_url: 'x',
        item_name: 'x',
      },
    ]);
    expect(res).toBeNull();
  });

  // ------------------------------------------------------------ 제휴 링크
  it('변환 결과를 upsert 하고, 같은 주소를 다시 넣어도 id 가 유지된다', async () => {
    const url = `https://example.com/very/long/${'x'.repeat(1500)}`;
    const first = await links.upsertMany(
      [{ partner: 'adpick', source_url: url, affiliate_url: 'https://adpick/1', status: 'ok', commission_per: 3.5, raw_response: { a: 1 }, converted_at: new Date().toISOString() }],
      30,
    );
    const again = await links.upsertMany(
      [{ partner: 'adpick', source_url: url, affiliate_url: 'https://adpick/2', status: 'ok' }],
      30,
    );
    expect(again.get(url)?.id).toBe(first.get(url)?.id);
    expect(again.get(url)?.affiliate_url).toBe('https://adpick/2');
    expect(first.get(url)?.commission_per).toBe(3.5);

    const usable = await links.findUsable([url, 'https://unknown']);
    expect([...usable.keys()]).toEqual([url]);
  });

  it('만료된 링크는 재사용하지 않는다', async () => {
    const url = 'https://example.com/expired';
    await links.upsertMany([{ partner: 'adpick', source_url: url, affiliate_url: 'a', status: 'ok' }], 0);
    await db.getPool()!.query('UPDATE affiliate_links SET expires_at = ? WHERE source_url = ?', [new Date(Date.now() - 1000), url]);
    expect((await links.findUsable([url])).size).toBe(0);
  });

  // ------------------------------------------------------------ 발화 캐시
  it('발화 캐시는 덮어쓰고, 만료되면 없는 것으로 본다', async () => {
    await intents.put('h1', { intent: 'hotel' }, 10);
    await intents.put('h1', { intent: 'flight' }, 10);
    expect(await intents.get('h1')).toEqual({ intent: 'flight' });
    await intents.put('h2', { intent: 'x' }, -1);
    expect(await intents.get('h2')).toBeNull();
  });

  // ------------------------------------------------------------ 지역
  it('지역 upsert 는 같은 (slug, kind) 면 같은 행이고, 별칭은 먼저 등록된 쪽이 이긴다', async () => {
    const a = await places.upsert(draft({}));
    const b = await places.upsert(draft({ canonicalName: '오사카시' }));
    expect(b?.id).toBe(a?.id);
    expect(b?.canonicalName).toBe('오사카시');

    const tokyo = await places.upsert(draft({ canonicalName: '도쿄', slug: 'tokyo', iata: 'NRT' }));
    await aliases.link('osaka', a!.id);
    await aliases.link('osaka', tokyo!.id);
    expect(await aliases.placeIdOf('osaka')).toBe(a!.id);
    expect(await aliases.placeIdOf('없음')).toBeNull();
  });

  it('하위 지역은 rank 순, rank 가 없으면 뒤로 간다. 이미 부모가 있으면 끌어올리지 않는다', async () => {
    const japan = await places.upsert(draft({ canonicalName: '일본', slug: 'japan', kind: 'country', iata: null }));
    const fukuoka = await places.upsert(draft({ canonicalName: '후쿠오카', slug: 'fukuoka', iata: 'FUK' }));
    const kyoto = await places.upsert(draft({ canonicalName: '교토', slug: 'kyoto', iata: null }));
    const sapporo = await places.upsert(draft({ canonicalName: '삿포로', slug: 'sapporo', iata: 'CTS' }));

    await places.attachCity(fukuoka!.id, japan!.id, 2, '텐진');
    await places.attachCity(kyoto!.id, japan!.id, 1, '기온');
    await places.attachCity(sapporo!.id, japan!.id, 0, null);
    await places.updateCityMeta(sapporo!.id, null as unknown as number, null);

    const children = await places.childrenOf(japan!.id, 'city');
    expect(children.map((p) => p.slug)).toEqual(['kyoto', 'fukuoka', 'sapporo']);

    const area = await places.upsert(draft({ canonicalName: '도톤보리', slug: 'dotonbori', kind: 'area', iata: null }));
    const osaka = await places.upsert(draft({}));
    await places.attachCity(area!.id, osaka!.id, 0, null);
    await places.attachCity(area!.id, japan!.id, 0, null); // 이미 부모가 있다 — 무시돼야 한다
    expect((await places.findById(area!.id))?.parentId).toBe(osaka!.id);

    expect(await places.countCities()).toBeGreaterThanOrEqual(5);
  });

  // ------------------------------------------------------------ 검색 결과(락)
  const meta: SearchMeta = { kind: 'hotel', placeName: '오사카', placeSlug: 'osaka' };

  it('선점은 먼저 꽂은 쪽만 true, 두 번째는 false', async () => {
    const osaka = await places.upsert(draft({}));
    const input = { cacheKey: 'hotel:1', kind: 'hotel' as const, placeId: osaka!.id, fromPlaceId: null, toPlaceId: null, tripType: null, meta };
    expect(await search.claim(input)).toBe(true);
    expect(await search.claim(input)).toBe(false);
  });

  it('⚠️ FK 위반은 "남이 먼저" (false) 가 아니라 실패 (null) 다', async () => {
    const input = { cacheKey: 'hotel:fk', kind: 'hotel' as const, placeId: 999_999, fromPlaceId: null, toPlaceId: null, tripType: null, meta };
    expect(await search.claim(input)).toBeNull();
  });

  it('완료 → 다시 읽기 → 본 updated_at 으로만 되찾을 수 있다 (낙관적 락)', async () => {
    await search.complete('hotel:1', [{ name: 'a' }, { name: 'b' }], 60, meta);
    const row = await search.get('hotel:1');
    expect(row).toMatchObject({ status: 'ready', items: [{ name: 'a' }, { name: 'b' }], meta });
    expect(row?.expiresAt).toBeGreaterThan(Date.now());

    expect(await search.reclaim('hotel:1', row!.updatedAt)).toBe(true);
    expect(await search.reclaim('hotel:1', row!.updatedAt)).toBe(false); // 이미 바뀌었다
    expect((await search.get('hotel:1'))?.status).toBe('pending');

    await search.fail('hotel:1', 'boom', -1);
    const failed = await search.get('hotel:1');
    expect(failed).toMatchObject({ status: 'failed', error: 'boom', items: [{ name: 'a' }, { name: 'b' }] });
    expect(await search.purgeExpired('hotel')).toBe(1);
    expect(await search.get('hotel:1')).toBeNull();
  });

  // ------------------------------------------------------------ 관광지
  it('관광지: 등록·중복·일괄·순서·노출·클릭·삭제', async () => {
    const osaka = await places.upsert(draft({}));
    const castle = await attractions.create({ cityId: osaka!.id, name: '오사카성', nameEn: 'Osaka Castle', area: '주오구', imageUrl: null, rank: 1 });
    expect(castle).toMatchObject({ name: '오사카성', rank: 1, source: 'manual' });
    expect(await attractions.create({ cityId: osaka!.id, name: '오사카성', nameEn: null, area: null, imageUrl: null, rank: 0 })).toBeNull();

    const inserted = await attractions.insertMany(osaka!.id, [
      { name: '오사카성', area: null, rank: 5 }, // 중복 — 건너뛴다
      { name: '도톤보리', area: '주오구', rank: 0 },
      { name: '유니버설', area: '고노하나구', rank: 0 },
    ]);
    expect(inserted).toBe(2);

    const list = await attractions.listByCity(osaka!.id);
    expect(list?.map((a) => a.name)).toEqual(['도톤보리', '유니버설', '오사카성']);
    expect((await attractions.listByCity(osaka!.id, 'ai'))?.length).toBe(2);

    const ids = list!.map((a) => a.id);
    expect(await attractions.reorder([...ids].reverse())).toBe(3);
    expect((await attractions.listByCity(osaka!.id))?.[0].name).toBe('오사카성');

    await attractions.registerImpressions([castle!.id, ids[0]]);
    const click = await attractions.registerClick(castle!.id);
    expect(click).toEqual({ attraction_name: '오사카성', city_name: '오사카', country_code: 'JP', clicks: 1 });
    expect(await attractions.registerClick(999_999)).toBeNull();

    const stats = await attractions.clickStats(osaka!.id, 10);
    expect(stats?.map((s) => [s.name, s.impression_count, s.click_count])).toEqual([
      ['오사카성', 1, 1],
      ['도톤보리', 1, 0],
    ]);

    const updated = await attractions.update(castle!.id, { area: null, image_url: 'https://cdn/a.jpg' });
    expect(updated).toMatchObject({ area: null, image_url: 'https://cdn/a.jpg', name_en: 'Osaka Castle' });
    expect(await attractions.update(999_999, { area: 'x' })).toBeNull();

    expect(await attractions.remove(castle!.id)).toEqual([{ id: castle!.id }]);
    expect(await attractions.remove(castle!.id)).toEqual([]);
  });
});

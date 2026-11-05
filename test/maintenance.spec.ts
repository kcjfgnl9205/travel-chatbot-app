import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { MaintenanceRepository } from '../src/modules/database/repositories/maintenance.repository';
import { MaintenanceController } from '../src/modules/maintenance/maintenance.controller';
import {
  CLEARED_TABLES,
  MaintenanceService,
  PRESERVED_TABLES,
} from '../src/modules/maintenance/maintenance.service';

/**
 * 서비스 데이터 초기화.
 *
 * **되돌릴 수 없는 유일한 경로다.** 그래서 여기서 지키는 것은 "잘 지워지는가" 보다
 * **지우면 안 되는 것을 안 지우는가** 와 **못 지웠을 때 지웠다고 하지 않는가** 쪽이다.
 */

const TOKEN = 'test-token';
const DATABASE = 'travel';

// ---------------------------------------------------------------- 컨트롤러
describe('초기화 API — 관문', () => {
  function build(over: { token?: string | undefined } = {}) {
    const calls: string[] = [];
    const service = {
      preview: async () => {
        calls.push('preview');
        return {};
      },
      reset: async () => {
        calls.push('reset');
        return {};
      },
    } as never;
    const config = { debugToken: 'token' in over ? over.token : TOKEN, mysqlDatabase: DATABASE } as never;
    return { controller: new MaintenanceController(config, service), calls };
  }

  it('DEBUG_TOKEN 이 비어 있으면 경로 자체가 없다', async () => {
    const { controller, calls } = build({ token: '' });
    await expect(controller.reset({ confirm: DATABASE }, '')).rejects.toThrow(NotFoundException);
    expect(calls).toEqual([]);
  });

  it('토큰이 틀리면 401', async () => {
    const { controller, calls } = build();
    await expect(controller.reset({ confirm: DATABASE }, 'nope')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(calls).toEqual([]);
  });

  /**
   * ⚠️ **토큰만으로는 못 지운다.** 토큰은 진단·관리 API 와 공유라 이미 손에 들고 있는
   *    경우가 많다. 지우려고 온 게 맞는지 DB 이름으로 한 번 더 가른다.
   */
  it('confirm 이 DB 이름과 다르면 400 이고, DB 는 건드리지도 않는다', async () => {
    const { controller, calls } = build();
    await expect(controller.reset({ confirm: 'travle' }, TOKEN)).rejects.toThrow(
      BadRequestException,
    );
    // 미리보기(COUNT)조차 돌지 않는다.
    expect(calls).toEqual([]);
  });

  it('토큰과 confirm 이 맞으면 비운다', async () => {
    const { controller, calls } = build();
    await controller.reset({ confirm: DATABASE }, TOKEN);
    expect(calls).toEqual(['reset']);
  });

  it('미리보기는 지우지 않는다', async () => {
    const { controller, calls } = build();
    await controller.preview(TOKEN);
    expect(calls).toEqual(['preview']);
  });
});

// ------------------------------------------------------------------ 서비스
describe('초기화 API — 무엇을 비우는가', () => {
  interface Over {
    counts?: Record<string, number> | null;
    truncate?: MaintenanceRepository['truncate'];
    available?: boolean;
  }

  function build(over: Over = {}) {
    const log: string[] = [];
    const truncated: string[][] = [];

    const maintenance = {
      available: over.available ?? true,
      countRows: async () => {
        log.push('count');
        if (over.counts === null) return null;
        return (
          over.counts ?? {
            recommendation_items: 10,
            recommendations: 5,
            messages: 5,
            users: 2,
            affiliate_links: 3,
            search_results: 4,
            intent_cache: 1,
            places: 112,
            place_aliases: 340,
            attractions: 2287,
          }
        );
      },
      truncate: async (tables: readonly string[]) => {
        log.push('truncate');
        truncated.push([...tables]);
        if (over.truncate) return over.truncate(tables);
        return { cleared: [...tables], failed: null };
      },
    } as never;

    const users = { clearMemory: () => log.push('users.clearMemory') } as never;
    const clicks = { clear: () => log.push('clicks.clear') } as never;
    const search = { clearMemory: () => log.push('search.clearMemory') } as never;
    const intent = { clearMemory: () => log.push('intent.clearMemory') } as never;
    const config = { mysqlDatabase: DATABASE } as never;

    return {
      service: new MaintenanceService(config, maintenance, users, clicks, search, intent),
      log,
      truncated,
    };
  }

  /**
   * ⚠️ **이 목록이 이 기능의 전부다.** 한 줄 늘어나는 순간 되돌릴 수 없는 것이 하나
   *    늘어난다. 특히 `attractions` 는 사람이 채운 데이터이고, TRUNCATE 하면
   *    auto_increment 가 1 로 돌아가 이미 나간 카드의 `/a/{id}` 가 엉뚱한 곳으로 열린다.
   */
  it('지역·관광지는 목록에 없다', () => {
    expect([...CLEARED_TABLES]).toEqual([
      'recommendation_items',
      'recommendations',
      'messages',
      'users',
      'affiliate_links',
      'search_results',
      'intent_cache',
    ]);
    for (const kept of PRESERVED_TABLES) {
      expect(CLEARED_TABLES).not.toContain(kept);
    }
  });

  it('비운 뒤에도 남긴 테이블의 행 수를 같이 돌려준다', async () => {
    const { service, truncated } = build();
    const result = await service.reset();

    expect(truncated).toEqual([[...CLEARED_TABLES]]);
    expect(result.cleared).toEqual({
      recommendation_items: 10,
      recommendations: 5,
      messages: 5,
      users: 2,
      affiliate_links: 3,
      search_results: 4,
      intent_cache: 1,
    });
    // 비운 뒤라 전부 0 이다.
    expect(result.total).toBe(0);
    expect(result.clears.messages).toBe(0);
    // 그대로 둔 것.
    expect(result.preserves).toEqual({ places: 112, place_aliases: 340, attractions: 2287 });
  });

  /**
   * ⚠️ **DB 를 비우고 나서 메모리를 비운다.** 반대로 하면 비우는 동안 들어온 요청이
   *    곧 사라질 행을 캐시에 다시 넣고, 그게 그대로 남는다.
   */
  it('DB 를 비운 뒤에 프로세스 캐시를 비운다', async () => {
    const { service, log } = build();
    await service.reset();

    expect(log).toEqual([
      'count',
      'truncate',
      'users.clearMemory',
      'clicks.clear',
      'search.clearMemory',
      'intent.clearMemory',
    ]);
  });

  /**
   * ⚠️ **users 캐시를 안 비우면 기록이 통째로 빈다.** UsersRepository 가 들고 있는
   *    user_id 는 비운 뒤 없는 행이고, 그 값으로 messages 를 넣으면 FK 위반이다.
   *    레포지토리는 예외 대신 null 을 돌려주므로 아무도 모르게 로그만 안 쌓인다.
   */
  it('users 캐시를 반드시 비운다', async () => {
    const { service, log } = build();
    await service.reset();
    expect(log).toContain('users.clearMemory');
  });

  /**
   * ⚠️ **DB 가 없으면 성공한 척하지 않는다.** 레포지토리는 DB 가 꺼져 있을 때 null 을
   *    돌려주고 앱은 그대로 도는데, 그 규칙을 여기서 그대로 따르면 "0행 지웠다" 는
   *    성공 응답이 나가고 운영은 다 지워진 줄 안다.
   */
  it('DB 가 꺼져 있으면 503 이고 아무것도 비우지 않는다', async () => {
    const { service, log } = build({ available: false });
    await expect(service.reset()).rejects.toThrow(ServiceUnavailableException);
    expect(log).toEqual([]);
  });

  it('세지 못하면 비우기로 넘어가지 않는다', async () => {
    const { service, log } = build({ counts: null });
    await expect(service.reset()).rejects.toThrow(ServiceUnavailableException);
    expect(log).toEqual(['count']);
  });

  /**
   * TRUNCATE 는 문장마다 암묵적 커밋이라 되돌릴 수 없다. 되돌리는 대신 **어디까지
   * 갔는지** 올린다 — 다시 부르면 남은 테이블부터 이어진다.
   */
  it('중간에 실패하면 어디까지 비웠는지 올린다', async () => {
    const { service } = build({
      truncate: async () => ({
        cleared: ['recommendation_items', 'recommendations'],
        failed: { table: 'messages', message: 'Lock wait timeout exceeded' },
      }),
    });

    await expect(service.reset()).rejects.toThrow(InternalServerErrorException);
    const err = await service.reset().catch((e: InternalServerErrorException) => e);
    const body = (err as InternalServerErrorException).getResponse() as {
      cleared: Record<string, number>;
      failed: { table: string };
    };
    expect(body.cleared).toEqual({ recommendation_items: 10, recommendations: 5 });
    expect(body.failed.table).toBe('messages');
  });

  it('부분 실패여도 프로세스 캐시는 비운다', async () => {
    // DB 가 일부라도 비었으면 그에 맞춰진 캐시도 틀린 값이다.
    const { service, log } = build({
      truncate: async () => ({
        cleared: ['recommendation_items'],
        failed: { table: 'recommendations', message: 'boom' },
      }),
    });
    await service.reset().catch(() => undefined);
    expect(log).toContain('users.clearMemory');
  });
});

// -------------------------------------------------------------- 레포지토리
describe('초기화 API — FK 검사를 되돌린다', () => {
  function fakeDb(over: { onQuery?: (sql: string) => void } = {}) {
    const queries: string[] = [];
    const conn = {
      query: async (sql: string) => {
        queries.push(sql);
        over.onQuery?.(sql);
        return [[], []];
      },
      release: () => queries.push('<release>'),
      destroy: () => queries.push('<destroy>'),
    };
    const pool = { getConnection: async () => conn, query: async () => [[], []] };
    return { db: { getPool: () => pool, enabled: true } as never, queries };
  }

  it('끄고 → 비우고 → 반드시 되돌린다', async () => {
    const { db, queries } = fakeDb();
    const repo = new MaintenanceRepository(db);

    const outcome = await repo.truncate(['messages', 'users']);

    expect(outcome).toEqual({ cleared: ['messages', 'users'], failed: null });
    expect(queries).toEqual([
      'SET SESSION foreign_key_checks = 0',
      'TRUNCATE TABLE `messages`',
      'TRUNCATE TABLE `users`',
      'SET SESSION foreign_key_checks = 1',
      '<release>',
    ]);
  });

  /**
   * ⚠️ **끈 채로 풀에 돌려보내면 그 커넥션을 집는 모든 요청이 FK 검사 없이 돈다.**
   *    TRUNCATE 가 실패하는 길에서도 반드시 되돌려야 한다.
   */
  it('비우다 실패해도 되돌린 뒤 커넥션을 돌려준다', async () => {
    const { db, queries } = fakeDb({
      onQuery: (sql) => {
        if (sql.includes('TRUNCATE TABLE `users`')) throw new Error('Lock wait timeout exceeded');
      },
    });
    const repo = new MaintenanceRepository(db);

    const outcome = await repo.truncate(['messages', 'users', 'intent_cache']);

    expect(outcome?.cleared).toEqual(['messages']);
    expect(outcome?.failed?.table).toBe('users');
    expect(queries).toContain('SET SESSION foreign_key_checks = 1');
    expect(queries[queries.length - 1]).toBe('<release>');
    // 실패한 지점 뒤는 건드리지 않는다.
    expect(queries).not.toContain('TRUNCATE TABLE `intent_cache`');
  });

  it('되돌리기에 실패한 커넥션은 풀에 돌려주지 않고 버린다', async () => {
    const { db, queries } = fakeDb({
      onQuery: (sql) => {
        if (sql.includes('foreign_key_checks = 1')) throw new Error('connection lost');
      },
    });
    const repo = new MaintenanceRepository(db);

    await repo.truncate(['messages']);

    expect(queries[queries.length - 1]).toBe('<destroy>');
    expect(queries).not.toContain('<release>');
  });

  it('DB 가 꺼져 있으면 null 이고 커넥션을 집지 않는다', async () => {
    const repo = new MaintenanceRepository({ getPool: () => null, enabled: false } as never);
    expect(await repo.truncate(['messages'])).toBeNull();
    expect(repo.available).toBe(false);
  });
});

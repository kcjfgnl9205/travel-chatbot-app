import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import {
  ClaimInput,
  SearchResultsRepository,
} from '../database/repositories/search-results.repository';
import { SearchMeta, SearchRow } from './search.types';

/**
 * 검색 결과 저장소. **캐시이자 동시 호출 방지 락이다.**
 *
 * 2단 구조다: 프로세스 메모리 → Supabase.
 *
 *   · **메모리 단**이 있는 이유는 DB 가 없거나 잠깐 흔들려도 **AI 를 다시 부르면 안 되기**
 *     때문이다. 저장소가 통째로 죽으면 요청 하나가 곧 API 요금이 된다.
 *   · **DB 단**이 있는 이유는 서버가 여러 대일 수 있고, 재시작해도 20건이 남아야
 *     하기 때문이다. 선점(락)의 최종 판정도 DB 가 한다.
 *
 * 선점이 이 파일의 핵심이다. 캐시가 빈 상태에서 세 명이 동시에 "오사카 호텔" 을 치면
 * 먼저 꽂은 하나만 검색해야 한다. 프로세스 안에서는 Map 에 동기적으로 꽂는 것으로,
 * 프로세스 밖으로는 `insert ... on conflict do nothing` 으로 가른다.
 */
@Injectable()
export class SearchStoreService {
  private readonly logger = new Logger(SearchStoreService.name);
  private readonly memory = new Map<string, SearchRow>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repo: SearchResultsRepository,
  ) {}

  /**
   * 저장된 행. **AI 는 절대 부르지 않는다** — 카카오 5초 예산 안에서 도는 유일한 조회다.
   *
   * 메모리에 쓸 만한 결과가 있으면 DB 를 보지 않는다. 그 외에는 DB 가 최종 판정이다
   * (다른 서버가 이미 끝내놨을 수 있다).
   */
  async get(cacheKey: string): Promise<SearchRow | null> {
    const local = this.memory.get(cacheKey);
    if (local && local.status === 'ready' && !isExpired(local)) return local;

    if (this.repo.enabled) {
      const row = await this.repo.get(cacheKey);
      if (row) {
        this.memory.set(cacheKey, row);
        return row;
      }
    }
    return local ?? null;
  }

  /**
   * 검색할 권리를 얻는다. **true 를 받은 요청만 provider 를 부른다.**
   *
   * @param seen 방금 읽은 행. 있으면 "그 상태 그대로일 때만" 되찾아온다(낙관적 잠금).
   */
  async claim(input: ClaimInput, seen: SearchRow | null): Promise<boolean> {
    const previous = this.memory.get(input.cacheKey) ?? null;
    // ⚠️ 동기적으로 꽂아야 한다. await 을 먼저 태우면 같은 프로세스의 다음 요청이
    //    그 사이에 들어와 둘 다 검색한다 (Node 는 await 지점에서만 양보한다).
    if (previous && this.isBusy(previous)) return false;
    this.memory.set(input.cacheKey, pendingRow(input, previous));

    if (!this.repo.enabled) return true;

    const claimed = seen?.updatedAt
      ? (await this.repo.reclaim(input.cacheKey, seen.updatedAt)) || (await this.repo.claim(input))
      : (await this.repo.claim(input)) || (await this.reclaimExisting(input));

    if (!claimed) {
      // 다른 서버가 먼저 잡았다. 메모리 선점을 되돌려야 우리가 그 행을 영영 pending 으로 들고 있지 않는다.
      if (previous) this.memory.set(input.cacheKey, previous);
      else this.memory.delete(input.cacheKey);
      this.logger.log(`search already claimed elsewhere key=${input.cacheKey}`);
    }
    return claimed;
  }

  /** 검색이 끝났다. 20건을 통째로 저장하고 TTL 을 건다. */
  async complete(
    cacheKey: string,
    items: unknown[],
    ttlMinutes: number,
    meta: SearchMeta,
  ): Promise<void> {
    const now = Date.now();
    this.memory.set(cacheKey, {
      ...(this.memory.get(cacheKey) ?? emptyRow(cacheKey, meta)),
      status: 'ready',
      items,
      meta,
      error: null,
      fetchedAt: now,
      expiresAt: now + ttlMinutes * 60_000,
      updatedAt: new Date(now).toISOString(),
    });
    if (this.repo.enabled) await this.repo.complete(cacheKey, items, ttlMinutes, meta);
  }

  /**
   * 검색이 실패했거나 빈손이었다.
   *
   * ⚠️ **항목은 지우지 않는다.** 예전에 찾아둔 결과가 있으면 "예전 정보예요" 로
   *    보여주는 편이 아무것도 못 주는 것보다 낫다.
   */
  async fail(cacheKey: string, error: string, ttlMinutes: number, meta: SearchMeta): Promise<void> {
    const now = Date.now();
    const previous = this.memory.get(cacheKey) ?? emptyRow(cacheKey, meta);
    this.memory.set(cacheKey, {
      ...previous,
      status: 'failed',
      meta,
      error,
      expiresAt: now + ttlMinutes * 60_000,
      updatedAt: new Date(now).toISOString(),
    });
    if (this.repo.enabled) await this.repo.fail(cacheKey, error, ttlMinutes);
  }

  /** 지금 누군가 검색 중인가. 죽은 pending 은 시간이 지나면 풀린다. */
  isBusy(row: SearchRow): boolean {
    if (row.status !== 'pending') return false;
    const since = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
    if (!Number.isFinite(since)) return true;
    return Date.now() - since < this.config.pendingTimeoutSeconds * 1000;
  }

  /** 테스트·운영 점검용. 메모리 단만 비운다. */
  clearMemory(): void {
    this.memory.clear();
  }

  // ---------------------------------------------------------------- 내부
  /** 이미 있는 행을 되찾아온다 — 만료됐거나, 실패했거나, pending 인 채 버려졌을 때만. */
  private async reclaimExisting(input: ClaimInput): Promise<boolean> {
    const row = await this.repo.get(input.cacheKey);
    if (!row) return false;
    if (this.isBusy(row)) return false;
    if (row.status === 'ready' && !isExpired(row)) return false;
    if (row.status === 'failed' && !isExpired(row)) return false;
    return this.repo.reclaim(input.cacheKey, row.updatedAt);
  }
}

/** 만료됐는가. expires_at 이 없으면 만료로 보지 않는다(검색 중인 행). */
export function isExpired(row: SearchRow): boolean {
  return row.expiresAt !== null && row.expiresAt <= Date.now();
}

function pendingRow(input: ClaimInput, previous: SearchRow | null): SearchRow {
  return {
    ...(previous ?? emptyRow(input.cacheKey, input.meta)),
    kind: input.kind,
    status: 'pending',
    meta: input.meta,
    updatedAt: new Date().toISOString(),
  };
}

function emptyRow(cacheKey: string, meta: SearchMeta): SearchRow {
  return {
    cacheKey,
    kind: meta.kind,
    status: 'pending',
    items: [],
    meta,
    error: null,
    fetchedAt: null,
    expiresAt: null,
    updatedAt: new Date().toISOString(),
  };
}

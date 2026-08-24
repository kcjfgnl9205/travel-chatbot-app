import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import { SearchCacheRepository } from '../database/repositories/search-cache.repository';
import { Hotel, HotelQuery } from '../hotel/hotel.types';

/**
 * 검색 결과 캐시.
 *
 * "오사카 호텔 추천해줘"를 다음 사람이 물으면 provider 를 다시 부르지 않고
 * 저장해둔 호텔 목록을 그대로 준다.
 *
 * AI provider 가 붙은 지금 이게 두 가지를 동시에 해결한다.
 *   · 속도 — gpt-5-mini + 웹 검색은 7~30초라 카카오 5초 제한을 넘긴다. 캐시 히트는 수십 ms
 *   · 비용 — 같은 도시를 100명이 물어도 OpenAI 호출은 1회
 *
 * 캐시에 담는 건 **provider 가 돌려준 호텔 목록**이지 완성된 카드가 아니다.
 * clickId 는 노출마다 새로 발급돼야 하므로 캐시 밖(service)에서 만든다.
 *
 * 2단 구조다: 프로세스 메모리 → Supabase.
 * 메모리 단이 있는 이유는 DB 가 없거나 잠깐 흔들려도 **OpenAI 를 다시 부르면 안 되기**
 * 때문이다. 캐시가 통째로 죽으면 요청 하나가 곧 API 요금이 된다.
 */

/** 프로세스 메모리 캐시 상한. 도시 수만큼만 쌓이므로 크게 잡을 이유가 없다. */
const MEMORY_MAX_ENTRIES = 200;

/**
 * 캐시 키.
 *
 * 지금은 'hotel:static:osaka::::5'. 날짜/인원 파싱이 붙으면 값을 이어 붙이면 된다
 * (cache_key 는 text 라 스키마 변경이 필요 없다).
 * provider 를 키에 넣는 이유: static → ai 로 바꿨을 때 옛 결과가 나오면 안 된다.
 */
export function buildCacheKey(domain: string, provider: string, query: HotelQuery): string {
  return [
    domain,
    provider,
    query.citySlug,
    query.guests ?? '',
    query.checkIn ?? '',
    query.checkOut ?? '',
    query.limit,
  ].join(':');
}

interface MemoryEntry {
  hotels: Hotel[];
  expiresAt: number;
}

@Injectable()
export class SearchCacheService {
  private readonly logger = new Logger(SearchCacheService.name);
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repo: SearchCacheRepository,
  ) {}

  /** TTL 이 0 이면 캐시를 끈다. DB 유무와 무관하게 메모리 단은 살아 있다. */
  get enabled(): boolean {
    return this.config.searchCacheTtlMinutes > 0;
  }

  private get ttlMs(): number {
    return this.config.searchCacheTtlMinutes * 60_000;
  }

  /**
   * 저장된 결과만 본다. **provider 는 절대 부르지 않는다.**
   *
   * 카카오 5초 예산 안에서 도는 유일한 조회 경로다. 미스면 호출부가 콜백으로 넘긴다.
   */
  async peek(domain: string, provider: string, query: HotelQuery): Promise<Hotel[]> {
    if (!this.enabled) return [];
    const cacheKey = buildCacheKey(domain, provider, query);

    const local = this.memory.get(cacheKey);
    if (local && local.expiresAt > Date.now()) {
      this.logger.log(`search cache hit (memory) key=${cacheKey} items=${local.hotels.length}`);
      return local.hotels;
    }
    if (local) this.memory.delete(cacheKey);

    if (!this.repo.enabled) return [];

    const cached = await this.repo.get(cacheKey);
    if (!cached?.payload) return [];

    const hotels = revive(cached.payload, this.logger);
    if (!hotels.length) return [];

    this.logger.log(`search cache hit (db) key=${cacheKey} items=${hotels.length}`);
    await this.repo.markHit(cached.id, cached.hit_count ?? 0);
    // DB 에서 살려온 건 메모리에도 얹는다. 같은 도시 연타를 DB 조회로 받아내지 않는다.
    this.remember(cacheKey, hotels);
    return hotels;
  }

  /** provider 가 돌려준 결과를 저장한다. */
  async store(
    domain: string,
    provider: string,
    query: HotelQuery,
    hotels: Hotel[],
  ): Promise<void> {
    // 빈 결과는 캐싱하지 않는다. 일시적 실패를 TTL 동안 굳혀버리면 안 된다.
    if (!this.enabled || !hotels.length) return;

    const cacheKey = buildCacheKey(domain, provider, query);
    this.remember(cacheKey, hotels);

    if (!this.repo.enabled) return;
    await this.repo.put({
      cacheKey,
      domain,
      provider,
      payload: hotels as unknown[],
      ttlMinutes: this.config.searchCacheTtlMinutes,
    });
  }

  /** 테스트·운영 점검용. 프로세스 메모리 단만 비운다. */
  clearMemory(): void {
    this.memory.clear();
  }

  private remember(cacheKey: string, hotels: Hotel[]): void {
    // 가장 오래된 항목부터 버린다 (Map 은 삽입 순서를 지킨다).
    if (this.memory.size >= MEMORY_MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(cacheKey, { hotels, expiresAt: Date.now() + this.ttlMs });
  }
}

/**
 * 캐시에 저장된 값을 Hotel 로 되돌린다.
 * 저장 당시와 필드가 달라졌을 수 있으므로(배포 직후) 깨지면 미스로 처리한다.
 */
function revive(payload: unknown, logger: Logger): Hotel[] {
  if (!Array.isArray(payload)) return [];
  const hotels = payload.filter(
    (h): h is Hotel =>
      Boolean(h) && typeof h === 'object' && typeof (h as Hotel).name === 'string',
  );
  if (hotels.length !== payload.length) {
    logger.warn('search cache payload incompatible; treating as miss');
    return [];
  }
  return hotels;
}

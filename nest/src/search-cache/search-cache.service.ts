import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../config/configuration';
import { SearchCacheRepository } from '../db/repositories/search-cache.repository';
import { Hotel, HotelQuery } from '../hotel/hotel.types';

/**
 * 검색 결과 캐시.
 *
 * "오사카 호텔 추천해줘"를 다음 사람이 물으면 provider 를 다시 부르지 않고
 * 저장해둔 호텔 목록을 그대로 준다.
 *
 * AI/크롤링 provider 가 붙으면 이게 두 가지를 동시에 해결한다.
 *   · 속도 — LLM 호출 3~10초는 카카오 5초 제한을 넘긴다. 캐시 히트는 수십 ms
 *   · 비용 — 같은 도시를 100명이 물어도 provider 호출은 1회
 *
 * 캐시에 담는 건 **provider 가 돌려준 호텔 목록**이지 완성된 카드가 아니다.
 * clickId 는 노출마다 새로 발급돼야 하므로 캐시 밖(service)에서 만든다.
 */

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

export interface CacheOutcome {
  hotels: Hotel[];
  cacheHit: boolean;
}

@Injectable()
export class SearchCacheService {
  private readonly logger = new Logger(SearchCacheService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repo: SearchCacheRepository,
  ) {}

  get enabled(): boolean {
    return this.config.searchCacheTtlMinutes > 0 && this.repo.enabled;
  }

  /**
   * 캐시에 있으면 그걸, 없으면 provider 를 부르고 저장한다.
   * cacheHit 은 recommendations.cache_hit 에 기록된다.
   */
  async getOrCall(
    domain: string,
    provider: string,
    query: HotelQuery,
    call: () => Promise<Hotel[]>,
  ): Promise<CacheOutcome> {
    if (!this.enabled) return { hotels: await call(), cacheHit: false };

    const cacheKey = buildCacheKey(domain, provider, query);
    const cached = await this.repo.get(cacheKey);

    if (cached?.payload) {
      const hotels = revive(cached.payload, this.logger);
      if (hotels.length) {
        this.logger.log(`search cache hit key=${cacheKey} items=${hotels.length}`);
        await this.repo.markHit(cached.id, cached.hit_count ?? 0);
        return { hotels, cacheHit: true };
      }
    }

    const hotels = await call();
    // 빈 결과는 캐싱하지 않는다. 일시적 실패를 TTL 동안 굳혀버리면 안 된다.
    if (hotels.length) {
      await this.repo.put({
        cacheKey,
        domain,
        provider,
        payload: hotels as unknown[],
        ttlMinutes: this.config.searchCacheTtlMinutes,
      });
    }
    return { hotels, cacheHit: false };
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

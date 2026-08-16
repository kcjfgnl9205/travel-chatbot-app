import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hotel, HotelProvider, HotelQuery } from '../hotel.types';

/**
 * Phase 1: data/hotels.json 고정 데이터.
 *
 * 파이썬판과 **같은 파일**을 읽는다(repo 루트의 data/hotels.json).
 * 두 구현이 같은 결과를 내는지 대조하려면 소스가 하나여야 한다.
 */
@Injectable()
export class StaticHotelProvider implements HotelProvider {
  readonly name = 'static';
  private cache: Hotel[] | null = null;

  private load(): Hotel[] {
    if (this.cache) return this.cache;

    // nest/dist 또는 nest/src 어디서 돌든 repo 루트의 data/ 를 찾는다.
    const candidates = [
      join(__dirname, '../../../../data/hotels.json'),
      join(__dirname, '../../../data/hotels.json'),
      join(process.cwd(), '../data/hotels.json'),
      join(process.cwd(), 'data/hotels.json'),
    ];

    let raw: string | null = null;
    for (const path of candidates) {
      try {
        raw = readFileSync(path, 'utf8');
        break;
      } catch {
        continue;
      }
    }
    if (raw === null) throw new Error('data/hotels.json 을 찾을 수 없습니다');

    const parsed = JSON.parse(raw) as { hotels: Record<string, any>[] };
    this.cache = parsed.hotels.map((h) => ({
      name: h.name,
      citySlug: h.city_slug,
      sourceUrl: h.source_url ?? '',
      merchant: h.merchant ?? null,
      source: h.source ?? 'manual',
      sourceRef: h.source_ref ?? null,
      address: h.address ?? null,
      starRating: h.star_rating ?? null,
      reviewScore: h.review_score ?? null,
      priceFrom: h.price_from ?? null,
      currency: h.currency ?? 'KRW',
      thumbnailUrl: h.thumbnail_url ?? null,
      description: h.description ?? null,
      tags: h.tags ?? [],
    }));
    return this.cache;
  }

  async search(query: HotelQuery): Promise<Hotel[]> {
    const hotels = this.load().filter((h) => h.citySlug === query.citySlug);
    // 평점 높은 순 → 가격 낮은 순
    hotels.sort(
      (a, b) =>
        (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
        (a.priceFrom ?? 1e9) - (b.priceFrom ?? 1e9),
    );
    return hotels.slice(0, query.limit);
  }
}

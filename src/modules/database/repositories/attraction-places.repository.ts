import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 도시별 관광지 목록 (`attraction_places`).
 *
 * **여기에만 영구로 남는다.** 구글 약관이 place_id 외 콘텐츠의 장기 보관을
 * 제한하므로, 이름·평점 같은 건 30일 캐시(search_results)에만 두고 이 테이블은
 * `place_id` 와 순서만 들고 있는다.
 *
 * 그래서 캐시가 비어도 **모델을 다시 부를 필요가 없다** — 순서는 여기 있으니
 * 구글에 place_id 로 다시 물어 살만 채우면 된다.
 */
@Injectable()
export class AttractionPlacesRepository extends BaseRepository {
  protected readonly tableName = 'attraction_places';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /** 도시의 관광지 목록을 추천 순서대로. */
  async listByCity(cityId: number): Promise<Record<string, any>[] | null> {
    return this.run(
      (t) => t.select('place_id, rank').eq('city_id', cityId).order('rank'),
      'list attraction places',
    );
  }

  /**
   * 도시의 목록을 통째로 갈아끼운다.
   *
   * ⚠️ **지우고 다시 넣지 않는다.** 그러면 first_seen_at 이 매번 초기화돼서 "언제부터
   *    있던 곳인가" 를 잃고, 그 사이에 조회한 요청이 빈 목록을 본다. upsert 로 순서만
   *    고치고, 이번에 안 온 곳은 따로 지운다.
   */
  async replaceCity(
    cityId: number,
    placeIds: string[],
  ): Promise<Record<string, any>[] | null> {
    const now = new Date().toISOString();
    const rows = placeIds.map((placeId, rank) => ({
      place_id: placeId,
      city_id: cityId,
      rank,
      updated_at: now,
    }));

    const saved = rows.length
      ? await this.run(
          (t) => t.upsert(rows, { onConflict: 'place_id' }).select('place_id'),
          'upsert attraction places',
        )
      : [];
    if (saved === null) return null;

    // 이번 목록에 없는 곳은 사라졌거나 밀려난 것이다. 남겨두면 rank 가 겹친다.
    if (placeIds.length) {
      await this.run(
        (t) =>
          t
            .delete()
            .eq('city_id', cityId)
            .not('place_id', 'in', `(${placeIds.map((id) => `"${id}"`).join(',')})`)
            .select('place_id'),
        'prune attraction places',
      );
    }
    return saved;
  }
}

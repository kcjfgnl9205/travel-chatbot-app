import { Injectable } from '@nestjs/common';

import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 도시별 관광지 목록 (`attractions`).
 *
 * **0008 의 attraction_places 를 대신한다.** 그쪽은 구글 place_id 만 들고 나머지는
 * 30일 캐시에 두는 구조였는데, 구글을 끊으면서 보관을 제한하는 약관이 사라졌다.
 * 이제 카드에 찍히는 값이 전부 이 테이블에 있다.
 *
 * ⚠️ **읽기는 요청 경로에서 돈다.** 쿼리 하나라 카카오 5초 예산 안에서 충분하다 —
 *    그게 구글·모델을 걷어낸 가장 큰 실익이다(더 이상 "찾고 있어요" 가 필요 없다).
 */
@Injectable()
export class AttractionsRepository extends BaseRepository {
  protected readonly tableName = 'attractions';

  /** 관리 화면·카드가 함께 쓰는 컬럼. 여기 없는 값은 카드에 못 찍힌다. */
  private static readonly COLUMNS =
    'id, city_id, name, name_en, area, image_url, image_source, rank, source';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  // ------------------------------------------------------------------ 읽기
  /**
   * 도시의 관광지를 노출 순서대로.
   *
   * `rank` 가 같으면 이름순으로 갈린다 — 순서를 안 정해둔 도시도 **매번 같은 순서**로
   * 나가야 한다. 정렬을 하나만 걸면 같은 rank 끼리 순서가 흔들려서, 사용자가 다시
   * 물었을 때 목록이 뒤바뀐 것처럼 보인다.
   */
  async listByCity(
    cityId: number,
    source?: 'manual' | 'ai',
  ): Promise<Record<string, any>[] | null> {
    return this.run(
      (t) => {
        const q = t.select(AttractionsRepository.COLUMNS).eq('city_id', cityId);
        // 검수용 필터. 모델이 넣은 것만 훑어보는 용도라 조회 경로에서는 안 쓴다.
        return (source ? q.eq('source', source) : q).order('rank').order('name');
      },
      'list attractions',
    );
  }

  async findById(id: number): Promise<Record<string, any> | null> {
    return this.runOne(
      (t) => t.select(AttractionsRepository.COLUMNS).eq('id', id),
      'find attraction',
    );
  }

  // ------------------------------------------------------------------ 쓰기
  /**
   * 한 곳 등록. 같은 도시에 같은 이름이 있으면 DB 가 막는다
   * (`attractions_city_name_key`) — 그때는 null 이 돌아온다.
   */
  async create(input: {
    cityId: number;
    name: string;
    nameEn: string | null;
    area: string | null;
    imageUrl: string | null;
    rank: number;
  }): Promise<Record<string, any> | null> {
    return this.runOne(
      (t) =>
        t
          .insert({
            city_id: input.cityId,
            name: input.name,
            // 카드에는 안 쓴다. 사진을 찾을 때만 쓰는 값이다.
            name_en: input.nameEn,
            area: input.area,
            image_url: input.imageUrl,
            rank: input.rank,
          })
          .select(AttractionsRepository.COLUMNS),
      'create attraction',
    );
  }

  /**
   * 주어진 칸만 고친다.
   *
   * ⚠️ **undefined 와 null 을 갈라야 한다.** "안 건드림"(undefined)과 "비움"(null)이
   *    같아지면, 이름만 고치려던 요청이 사진을 지운다. 호출부에서 걸러 넘긴다.
   */
  async update(
    id: number,
    patch: Record<string, unknown>,
  ): Promise<Record<string, any> | null> {
    return this.runOne(
      (t) =>
        t
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', id)
          .select(AttractionsRepository.COLUMNS),
      'update attraction',
    );
  }

  /** 지운다. 지워진 행을 돌려준다 — 없으면 빈 배열이라 404 를 가릴 수 있다. */
  async remove(id: number): Promise<Record<string, any>[] | null> {
    return this.run((t) => t.delete().eq('id', id).select('id'), 'delete attraction');
  }

  /**
   * 모델이 채운 목록을 한 번에 넣는다 (`source='ai'`).
   *
   * ⚠️ **`ignoreDuplicates` 로 넣는다.** 유니크 인덱스(city_id, name)에 걸리는 행이
   *    하나라도 있으면 plain insert 는 **배열 전체가 실패한다.** 사람이 두 곳쯤
   *    미리 넣어둔 도시에서 모델이 같은 이름을 내면 나머지 열여덟 곳까지 같이
   *    날아가는데, 그건 "겹치는 것만 빼고 넣기" 보다 명백히 나쁘다.
   *
   * @returns 실제로 들어간 수. 제안한 수와 벌어지면 중복이 많았다는 뜻이다.
   */
  async insertMany(
    cityId: number,
    items: { name: string; area: string | null; nameEn?: string | null; rank: number }[],
  ): Promise<number> {
    if (!items.length) return 0;

    const rows = items.map((item) => ({
      city_id: cityId,
      name: item.name,
      // 카드에는 안 쓴다. 사진을 찾을 때만 쓰는 값이다.
      name_en: item.nameEn ?? null,
      area: item.area,
      // 모델은 사진 주소를 지어낸다. 빈 채로 두고 운영이 나중에 넣는다.
      image_url: null,
      rank: item.rank,
      source: 'ai',
    }));

    const saved = await this.run(
      (t) =>
        t
          .upsert(rows, { onConflict: 'city_id,name', ignoreDuplicates: true })
          .select('id'),
      'insert ai attractions',
    );
    return saved?.length ?? 0;
  }

  /**
   * 한 도시의 순서를 통째로 다시 매긴다. 관리 화면의 드래그 정렬용이다.
   *
   * ⚠️ **upsert 가 아니라 건별 update 다.** upsert 로 하면 목록에 없는 칸(name·city_id)이
   *    비어 들어가서 행이 망가진다. 순서만 고치는 게 이 함수의 전부다.
   */
  async reorder(ids: number[]): Promise<number> {
    const now = new Date().toISOString();
    let moved = 0;
    for (const [rank, id] of ids.entries()) {
      const row = await this.runOne(
        (t) => t.update({ rank, updated_at: now }).eq('id', id).select('id'),
        'reorder attraction',
      );
      if (row) moved += 1;
    }
    return moved;
  }
}

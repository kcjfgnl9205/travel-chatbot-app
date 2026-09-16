import { Injectable } from '@nestjs/common';

import { Place, PlaceDraft, PlaceKind } from '../../places/places.types';
import { SupabaseService } from '../supabase.service';
import { BaseRepository } from './base.repository';

/**
 * 지역 마스터.
 *
 * **미리 채우지 않는다.** 질의를 받을 때마다 모르는 지역을 등록하며 자란다.
 * 그래서 upsert 가 기본이다 — 두 요청이 같은 지역을 동시에 등록하려 할 수 있고,
 * 그때 한쪽이 에러로 죽으면 사용자는 이유 없이 빈손이 된다.
 */
@Injectable()
export class PlacesRepository extends BaseRepository {
  protected readonly tableName = 'places';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async findById(id: number): Promise<Place | null> {
    const row = await this.runOne(
      (t) => t.select(COLUMNS).eq('id', id).limit(1),
      'select place',
    );
    return row ? toPlace(row) : null;
  }

  /**
   * 이 지역에 매달린 하위 지역. 나라의 도시 목록이 여기서 나온다.
   *
   * **인기 순서(rank)로 정렬한다.** 등록 순으로 주면 나중에 목록을 고쳤을 때 순서가
   * 뒤섞이고, 카드 맨 위에 엉뚱한 도시가 온다.
   */
  async childrenOf(parentId: number, kind: PlaceKind): Promise<Place[]> {
    const rows = await this.run(
      (t) =>
        t
          .select(COLUMNS)
          .eq('parent_id', parentId)
          .eq('kind', kind)
          .order('rank', { ascending: true, nullsFirst: false })
          .order('id'),
      'select child places',
    );
    return (rows ?? []).map(toPlace);
  }

  /**
   * 도시를 나라에 매단다. 순서와 한 줄 설명도 같이 채운다.
   *
   * 부모가 이미 있으면 건드리지 않는다 — 도톤보리(오사카 소속)를 나라 밑으로 끌어올리면
   * "도톤보리 주변" 이라는 정보가 사라진다.
   */
  async attachCity(
    placeId: number,
    parentId: number,
    rank: number,
    blurb: string | null,
  ): Promise<void> {
    await this.run(
      (t) =>
        t
          .update({ parent_id: parentId, rank, blurb })
          .eq('id', placeId)
          .is('parent_id', null)
          .select('id'),
      'attach city to country',
    );
  }

  /**
   * 이미 매달린 도시의 순서·설명만 고친다.
   *
   * attachCity 는 부모가 없는 행만 건드린다(도톤보리를 나라 밑으로 끌어올리지 않으려고).
   * 그래서 이미 나라에 붙어 있던 도시는 rank·blurb 가 영영 비어 있었고, 카드에 설명
   * 없는 줄이 나갔다.
   */
  async updateCityMeta(placeId: number, rank: number, blurb: string | null): Promise<void> {
    await this.run(
      (t) => t.update({ rank, blurb }).eq('id', placeId).select('id'),
      'update city meta',
    );
  }

  /** (slug, kind) 가 같으면 같은 지역으로 본다. 있으면 그 행을, 없으면 새 행을 준다. */
  async upsert(draft: PlaceDraft): Promise<Place | null> {
    const row = await this.runOne(
      (t) =>
        t
          .upsert(
            {
              canonical_name: draft.canonicalName,
              slug: draft.slug,
              country_code: draft.countryCode,
              kind: draft.kind,
              iata: draft.iata,
              parent_id: draft.parentId,
            },
            { onConflict: 'slug,kind' },
          )
          .select(COLUMNS),
      'upsert place',
    );
    return row ? toPlace(row) : null;
  }
}

/** 별칭 → 지역. 이 테이블이 곧 캐시 적중률이다. */
@Injectable()
export class PlaceAliasesRepository extends BaseRepository {
  protected readonly tableName = 'place_aliases';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async placeIdOf(alias: string): Promise<number | null> {
    const row = await this.runOne(
      (t) => t.select('place_id').eq('alias', alias).limit(1),
      'select place alias',
    );
    const id = Number(row?.place_id);
    return Number.isFinite(id) ? id : null;
  }

  /** 이미 있으면 그대로 둔다 — 먼저 등록된 쪽이 정답이다. */
  async link(alias: string, placeId: number): Promise<void> {
    await this.run(
      (t) =>
        t
          .upsert({ alias, place_id: placeId }, { onConflict: 'alias', ignoreDuplicates: true })
          .select('alias'),
      'insert place alias',
    );
  }
}

const COLUMNS = 'id, canonical_name, slug, country_code, kind, iata, parent_id, rank, blurb';

function toPlace(row: Record<string, any>): Place {
  return {
    id: Number(row.id),
    canonicalName: String(row.canonical_name ?? ''),
    slug: String(row.slug ?? ''),
    countryCode: row.country_code ?? null,
    kind: (row.kind ?? 'city') as PlaceKind,
    iata: row.iata ?? null,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    rank: row.rank == null ? null : Number(row.rank),
    blurb: row.blurb ?? null,
  };
}

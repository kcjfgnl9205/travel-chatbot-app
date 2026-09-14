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

  /** 이 지역에 매달린 하위 지역. 나라의 도시 목록이 여기서 나온다. */
  async childrenOf(parentId: number, kind: PlaceKind): Promise<Place[]> {
    const rows = await this.run(
      (t) => t.select(COLUMNS).eq('parent_id', parentId).eq('kind', kind).order('id'),
      'select child places',
    );
    return (rows ?? []).map(toPlace);
  }

  /** 부모를 나중에 붙인다. 사전에서 온 도시는 나라를 모르는 채로 먼저 등록된다. */
  async setParent(placeId: number, parentId: number): Promise<void> {
    await this.run(
      (t) => t.update({ parent_id: parentId }).eq('id', placeId).is('parent_id', null).select('id'),
      'set place parent',
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

const COLUMNS = 'id, canonical_name, slug, country_code, kind, iata, parent_id';

function toPlace(row: Record<string, any>): Place {
  return {
    id: Number(row.id),
    canonicalName: String(row.canonical_name ?? ''),
    slug: String(row.slug ?? ''),
    countryCode: row.country_code ?? null,
    kind: (row.kind ?? 'city') as PlaceKind,
    iata: row.iata ?? null,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
  };
}

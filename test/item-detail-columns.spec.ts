import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config/app.config';
import { AttractionService } from '../src/modules/attraction/attraction.service';
import { Attraction } from '../src/modules/attraction/attraction.types';
import { FlightService } from '../src/modules/flight/flight.service';
import { Flight } from '../src/modules/flight/flight.types';
import { HotelService } from '../src/modules/hotel/hotel.service';
import { Hotel } from '../src/modules/hotel/hotel.types';
import { ItemRow } from '../src/modules/recommendation/rows.service';
import { RenderContext } from '../src/modules/search/search.types';

/**
 * 도메인이 넘기는 `detail` 의 키가 **실제 테이블 컬럼과 맞는지** 본다.
 *
 * **이 파일이 막는 사고는 조용하다.** 컬럼 이름을 하나 틀리면(camelCase 로 쓴다든가,
 * 마이그레이션에만 추가하고 서비스는 안 고친다든가) insert 가 통째로 실패하는데,
 * 저장소가 오류를 삼키므로(base.repository — 로깅 실패로 사용자 응답을 막지 않는다)
 * 경고 한 줄만 남고 카드는 멀쩡히 나간다. 그 도메인의 상세가 영영 안 쌓이는데
 * 아무도 모른다.
 *
 * 그래서 마이그레이션 파일을 직접 읽어서 대조한다. DB 없이 도는 테스트다.
 */

/**
 * 마이그레이션 전부를 순서대로 읽어 **최종 컬럼 목록**을 만든다.
 *
 * 한 파일만 보면 안 된다 — 0007 이 만든 칸을 0008 이 지우기도 하기 때문이다.
 * add 와 drop 을 파일 순서대로 적용해야 지금 DB 와 같은 결과가 나온다.
 */
function columnsOf(table: string): string[] {
  const dir = join(__dirname, '../supabase/migrations');
  const columns = new Set<string>();

  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    // 한 파일 안에 같은 테이블을 여러 번 alter 할 수 있다.
    for (const block of sql.split(`alter table public.${table}`).slice(1)) {
      const statement = block.split(';')[0];
      for (const [, name] of statement.matchAll(/add column if not exists\s+(\w+)/g)) {
        columns.add(name);
      }
      for (const [, name] of statement.matchAll(/drop column if exists\s+(\w+)/g)) {
        columns.delete(name);
      }
    }
  }

  if (!columns.size) throw new Error(`마이그레이션에 ${table} 컬럼이 없다`);
  return [...columns];
}

const CTX = (kind: 'hotel' | 'flight' | 'attraction'): RenderContext => ({
  meta: { kind, placeName: '오사카', placeSlug: 'osaka' },
  userId: null,
  messageId: null,
  started: Date.now(),
  cacheHit: false,
});

/** 렌더러를 가짜로 세워서 도메인이 넘긴 ItemRow 만 가로챈다. */
function capture() {
  const rows: ItemRow[] = [];
  const renderer = {
    render: async (items: ItemRow[]) => {
      rows.push(...items);
      return [];
    },
  } as never;
  return { rows, renderer };
}

/** 링크 해석을 타지 않게 빈 Map 을 넘긴다 (변환은 이 테스트의 관심사가 아니다). */
const noAffiliate = { resolve: async () => new Map() } as never;

describe('detail 키가 실제 컬럼과 맞는가', () => {
  it('관광지', async () => {
    const { rows, renderer } = capture();
    const attraction: Attraction = {
      placeId: 'ChIJ_osaka_castle',
      name: '오사카성',
      citySlug: 'osaka',
      mapUrl: 'https://maps/1',
      category: '역사/문화',
      area: '주오구',
      rating: 4.4,
      userRatingCount: 61234,
      imageUrl: 'https://img/1.jpg',
    };

    await new AttractionService({ name: 'fake' } as never, renderer).rows(
      [attraction],
      CTX('attraction'),
    );

    expect(Object.keys(rows[0].detail ?? {}).sort()).toEqual(
      columnsOf('recommendation_item_attractions').sort(),
    );
  });

  it('호텔', async () => {
    const { rows, renderer } = capture();
    const hotel: Hotel = {
      name: '호텔 A',
      citySlug: 'osaka',
      sourceUrl: 'https://trip.com/1',
      starRating: 4,
      reviewScore: 8.7,
      priceFrom: 120000,
      merchant: 'trip',
      thumbnailUrl: 'https://img/h.jpg',
    };

    await new HotelService({ name: 'fake' } as never, noAffiliate, renderer).rows(
      [hotel],
      CTX('hotel'),
    );

    // affiliate_link_id 는 도메인이 아니라 rows.service 가 채운다 (그래서 여기 없다).
    expect(Object.keys(rows[0].detail ?? {}).sort()).toEqual(
      columnsOf('recommendation_item_hotels')
        .filter((c) => c !== 'affiliate_link_id')
        .sort(),
    );
  });

  it('항공권', async () => {
    const { rows, renderer } = capture();
    const flight: Flight = {
      airline: '대한항공',
      flightNo: 'KE723',
      originCode: 'ICN',
      destCode: 'KIX',
      tripType: 'round',
      sourceUrl: 'https://trip.com/f',
      stops: 0,
      cabin: 'economy',
      durationMinutes: 115,
      priceFrom: 210000,
      merchant: 'trip',
    };

    await new FlightService(loadConfig(), { name: 'fake' } as never, noAffiliate, renderer).rows(
      [flight],
      CTX('flight'),
    );

    expect(Object.keys(rows[0].detail ?? {}).sort()).toEqual(
      columnsOf('recommendation_item_flights')
        .filter((c) => c !== 'affiliate_link_id')
        .sort(),
    );
  });
});

import { Injectable, Logger } from '@nestjs/common';

import { mapsUrl } from '../../../common/maps-url';
import { text } from '../../../common/parse';
import { AttractionsRepository } from '../../database/repositories/attractions.repository';
import { Attraction, AttractionProvider, AttractionQuery } from '../attraction.types';

/**
 * 관광지 provider. **우리 DB 가 전부다.**
 *
 * 0008 은 3단이었다 — 구글이 후보를 주고, 모델이 순서를 정하고, 위키미디어가 사진을
 * 붙였다. 도시 하나에 구글 6회 + 모델 2회 + 사진 최대 20회가 나가서 7~30초가 걸렸고,
 * 그래서 백그라운드 + 콜백이 필요했다.
 *
 * 지금은 **쿼리 하나**다. 그래서 요청 경로에서 그대로 돌고, 사용자는 "찾고 있어요"
 * 를 보지 않는다 ([AttractionService.instant](../attraction.service.ts)).
 *
 * 걷어내면서 같이 사라진 것들 —
 *
 *   · API 요금 (Places Enterprise SKU 는 무료 한도가 월 1,000회뿐이었다)
 *   · 구글 출처 표시 의무 (남의 콘텐츠를 안 보여준다)
 *   · 사진 저작자 표시 의무 (위키미디어 CC BY-SA)
 *   · 30일 보관 제한 (약관이 place_id 외 콘텐츠의 장기 보관을 막았다)
 *
 * 대신 **목록을 사람이 채워야 한다.** 비어 있는 도시는 빈손으로 돌아가고, 라우터가
 * "아직 준비 안 됐어요" 로 받는다. 그게 이 설계의 유일한 비용이다.
 */
@Injectable()
export class DbAttractionProvider implements AttractionProvider {
  readonly name = 'db';
  private readonly logger = new Logger(DbAttractionProvider.name);

  constructor(private readonly attractions: AttractionsRepository) {}

  /**
   * DB 가 없으면 목록도 없다. 메모리 폴백을 두지 않는다 — 관광지 목록은 사람이
   * 넣은 것이라 코드에 사본이 있을 수 없고, 있는 척하면 빈 카드가 나간다.
   */
  get enabled(): boolean {
    return this.attractions.enabled;
  }

  async search(query: AttractionQuery): Promise<Attraction[]> {
    const started = Date.now();
    const rows = await this.attractions.listByCity(query.cityId);

    if (rows === null) {
      // DB 가 흔들렸다. 빈 목록(= "아직 안 넣었다")과 구별해야 한다 —
      // 전자는 잠시 뒤 되고, 후자는 사람이 넣기 전까지 영원히 안 된다.
      this.logger.warn(`db unavailable city=${query.cityName}`);
      return [];
    }

    const items = rows
      .map((row) => toAttraction(row, query))
      .filter((a): a is Attraction => a !== null)
      .slice(0, query.limit);

    this.logger.log(
      `attractions city=${query.cityName} rows=${rows.length} sent=${items.length} ms=${Date.now() - started}`,
    );
    if (!items.length) {
      // 운영이 보고 채워야 하는 신호다. 경고로 남긴다.
      this.logger.warn(`no attractions registered city=${query.cityName}`);
    }
    return items;
  }
}

/**
 * DB 행 → 카드에 쓸 값.
 *
 * ⚠️ **이름이 없으면 버린다.** 카드 제목이 빈 줄은 사용자에게 아무 의미가 없고,
 *    listCard 는 title 이 비면 그 줄을 이상하게 그린다.
 */
export function toAttraction(
  row: Record<string, any>,
  query: AttractionQuery,
): Attraction | null {
  const id = Number(row.id);
  const name = text(row.name);
  if (!Number.isFinite(id) || !name) return null;

  return {
    id,
    name,
    citySlug: query.citySlug,
    area: text(row.area),
    // 카카오는 http 이미지를 그리지 않는다. 걸러서 "사진 없음" 으로 떨어뜨리는 게
    // 깨진 자리를 남기는 것보다 낫다.
    imageUrl: httpsOnly(text(row.image_url)),
    mapUrl: mapsUrl(name, query.cityName),
  };
}

/** https 가 아니면 없는 것으로 친다. */
export function httpsOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

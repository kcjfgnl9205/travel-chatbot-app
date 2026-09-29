import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import { AttractionsRepository } from '../database/repositories/attractions.repository';
import { FoundImage, findAttractionImage } from './attraction-image';

/**
 * 관광지 사진을 **위키미디어에서 찾아 채운다.**
 *
 * ⚠️ **모델에게 사진 주소를 묻지 않는다.** 그럴듯한 CDN 주소를 지어내고, 그건 카드에
 *    깨진 자리만 남긴다(호텔에서 확인된 것). 위키미디어 API 는 구조화된 주소를 주므로
 *    지어낼 자리가 없다 — 그래서 목록은 모델이 채워도 사진은 여기가 채운다.
 *
 * ⚠️ **구글 Places 사진도 쓰지 않는다.** 커버리지는 더 높지만 이미지 주소가 만료되는데,
 *    카카오 카드는 단톡방에 영구히 남아서 사람들이 나중에 스크롤해 다시 본다 —
 *    며칠 뒤 깨진 자리가 남는다. 위키미디어 주소는 안 죽는다.
 *
 * ⚠️ **영문명(`name_en`)이 커버리지를 가른다.** 위키미디어 커먼즈의 파일명은 거의
 *    영문이라 한국어 이름으로는 거의 못 찾는다. 후쿠오카 실측 —
 *    영문명 없이 **4/14**, 있으면 **11/14** 이고 그중 6건이 커먼즈에서 나왔다.
 *    그래서 백필이 목록을 받을 때 영문명을 같이 받는다.
 *
 * **사람이 넣은 사진은 건드리지 않는다.** 비어 있는 칸만 채운다 — 운영이 고른 사진이
 * 자동 탐색으로 덮이면 고쳐놓은 게 되돌아간다.
 *
 * ⚠️ 위키미디어 사진은 대부분 저작자 표시가 필요한 라이선스다. 그래서 찾은 문서 주소를
 *    `image_source` 에 같이 남긴다 — 예전에 이 탐색을 걷어낸 이유 중 하나가 "출처를
 *    저장하지 않아 밝힐 수가 없다" 였다.
 */
@Injectable()
export class AttractionImageService {
  private readonly logger = new Logger(AttractionImageService.name);
  /** 같은 도시를 동시에 두 번 훑지 않는다. */
  private readonly filling = new Set<number>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly attractions: AttractionsRepository,
  ) {}

  get enabled(): boolean {
    return this.config.attractionImages && this.attractions.enabled;
  }

  /**
   * 한 도시에서 **사진이 비어 있는 관광지만** 채운다.
   *
   * ⚠️ 느리다(한 곳당 최대 3회 조회). 요청 경로에서 부르면 안 된다 —
   *    백필이 끝난 뒤나 관리 API 에서만 부른다.
   *
   * @param cityNameEn 영어판·커먼즈 검색에 쓸 도시명. 슬러그가 이미 영문이다.
   */
  async fillCity(
    cityId: number,
    cityName: string,
    cityNameEn: string,
  ): Promise<{ filled: number; missing: number }> {
    const none = { filled: 0, missing: 0 };
    if (!this.enabled || this.filling.has(cityId)) return none;
    this.filling.add(cityId);

    try {
      const rows = await this.attractions.listByCity(cityId);
      if (!rows) return none;

      const blank = rows.filter((row) => !row.image_url);
      if (!blank.length) return none;

      // 동시에 찾는다. 위키미디어는 무료지만 예의상 도시 단위로만 몰아친다.
      const found = await Promise.all(
        blank.map((row) =>
          this.fillOne(
            Number(row.id),
            String(row.name),
            // ⚠️ **영문명이 커버리지를 가른다.** 커먼즈 파일명은 거의 영문이라
            //    한국어로는 안 걸린다 — 후쿠오카 실측 4/14 → 11/14.
            typeof row.name_en === 'string' ? row.name_en : null,
            cityName,
            cityNameEn,
          ),
        ),
      );
      const filled = found.filter(Boolean).length;

      this.logger.log(
        `images city=${cityName} filled=${filled}/${blank.length} total=${rows.length}`,
      );
      return { filled, missing: blank.length - filled };
    } finally {
      this.filling.delete(cityId);
    }
  }

  /** 한 곳. 못 찾으면 false — 그 줄은 사진 없이 나간다. */
  private async fillOne(
    id: number,
    name: string,
    nameEn: string | null,
    cityName: string,
    cityNameEn: string,
  ): Promise<boolean> {
    let found: FoundImage | null = null;
    try {
      found = await findAttractionImage(
        name,
        nameEn,
        cityName,
        cityNameEn,
        this.config.attractionImageTimeoutMs,
      );
    } catch (err) {
      // 사진은 있으면 좋은 것이지 없으면 안 되는 것이 아니다.
      this.logger.warn(`image lookup failed attraction=${name} err=${err}`);
      return false;
    }

    if (!found) {
      this.logger.log(`no image attraction=${name}`);
      return false;
    }

    const saved = await this.attractions.update(id, {
      image_url: found.url,
      image_source: found.pageUrl,
    });
    if (!saved) return false;

    // 어디서 건졌는지 남긴다 — 커먼즈를 더한 게 값을 하는지는 이 비율로 본다.
    this.logger.log(`image ${found.lang} attraction=${name} doc=${found.title}`);
    return true;
  }
}

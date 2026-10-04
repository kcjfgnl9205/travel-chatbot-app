import { Controller, Get, Logger, Param, ParseIntPipe, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { kakaoMapUrl, mapsUrl } from '../../common/maps-url';
import { lookupCity } from '../places/city-table';
import { MemoryStoreService } from '../database/memory-store.service';
import { AttractionsRepository } from '../database/repositories/attractions.repository';
import { RecommendationItemsRepository } from '../database/repositories/recommendations.repository';

/**
 * 클릭 추적 리다이렉트.
 *
 * 카카오 listCard 의 줄 링크가 가리키는 곳. 여기를 한 번 거쳐야
 * "사용자가 어떤 호텔을 눌렀는지"를 DB에 남길 수 있다.
 *
 * ⚠️ **사용자가 302 를 기다리는 경로다.** 여기서 쓰는 시간이 곧 "링크가 느리다" 다.
 *
 * 그래서 **DB 를 기다리지 않는 길을 먼저 본다.** 방금 나간 카드의 목적지는 이미
 * 인메모리에 있으므로, 있으면 즉시 302 를 보내고 카운터는 뒤에서 올린다.
 *
 * 운영 서버에서 실측한 값 (서버 → Supabase, 3회 평균):
 *
 *   따뜻한 연결   ~90ms     한 번 걸리는 값 자체는 크지 않다
 *   **콜드 연결   ~730ms**  배포 직후 첫 클릭들이 내는 비용
 *
 * 90ms 를 아끼자는 게 아니라 **목적지를 아는데 기다릴 이유가 없다**는 쪽이다.
 * 발화 하나가 DB 를 7번 왕복하는 구조라(DEPLOY.md) 뺄 수 있는 왕복은 빼둔다.
 *
 * 메모리에 없으면(배포로 비었거나 오래된 카드) 지금처럼 DB 를 기다린다. 목적지를
 * 모르는 채로 보낼 수는 없기 때문이다. DB 왕복은 그때도 **한 번**이다 —
 * register_click() 이 조회·증가·목적지 반환을 동시에 한다.
 */
const EXPIRED_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>링크를 찾을 수 없어요</title></head>
<body style="font-family:-apple-system,sans-serif;padding:48px 24px;text-align:center">
<h2>링크가 만료되었어요</h2>
<p>챗봇에서 호텔을 다시 추천받아 주세요.</p>
</body></html>`;

/** 관광지 쪽 문구. 지워진 곳이라 "만료" 가 아니다 — 다시 물어도 그 줄은 없다. */
const GONE_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>관광지를 찾을 수 없어요</title></head>
<body style="font-family:-apple-system,sans-serif;padding:48px 24px;text-align:center">
<h2>없어진 관광지예요</h2>
<p>챗봇에서 관광지를 다시 추천받아 주세요.</p>
</body></html>`;

@ApiTags('리다이렉트')
@Controller()
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);

  constructor(
    private readonly items: RecommendationItemsRepository,
    private readonly memory: MemoryStoreService,
    private readonly attractions: AttractionsRepository,
  ) {}

  @Get('r/:clickId')
  @ApiOperation({
    summary: '클릭 추적 후 제휴 주소로 이동',
    description:
      '카카오 listCard 줄 링크가 가리키는 곳. click_count 를 올리고 302 로 보낸다.\n' +
      'DB 왕복은 한 번이다 (register_click 함수가 조회·증가·목적지 반환을 동시에 한다).',
  })
  @ApiParam({ name: 'clickId', description: '추천 응답 시 호텔마다 발급된 12자 키' })
  @ApiResponse({ status: 302, description: '애드픽 커미션 링크로 이동' })
  @ApiResponse({ status: 404, description: '없거나 만료된 clickId' })
  async redirect(@Param('clickId') clickId: string, @Res() res: Response): Promise<void> {
    // ① 빠른 길 — 목적지를 이미 알고 있으면 DB 를 기다리지 않는다.
    const cached = this.memory.registerClick(clickId);
    if (cached) {
      res.redirect(302, cached.targetUrl);
      // 카운터는 사용자를 보낸 뒤에 올린다. 실패해도 기록 한 건을 잃을 뿐이고,
      // 그것 때문에 사용자를 1초 넘게 붙잡아 둘 이유는 없다.
      void this.items
        .registerClick(clickId)
        .catch((err) => this.logger.warn(`click count failed clickId=${clickId} err=${err}`));
      this.logger.log(`click clickId=${clickId} item=${cached.itemName} via=memory`);
      return;
    }

    // ② 느린 길 — 목적지를 모르니 DB 를 기다릴 수밖에 없다.
    //    배포로 메모리가 비었거나, 단톡방에 오래 남아 있던 카드를 누른 경우다.
    const row = await this.items.registerClick(clickId);
    const targetUrl = (row?.target_url as string) ?? null;

    if (!targetUrl) {
      this.logger.warn(`unknown clickId=${clickId}`);
      res.status(404).type('html').send(EXPIRED_HTML);
      return;
    }

    this.logger.log(
      `click clickId=${clickId} item=${row?.item_name as string} ` +
        `count=${row?.click_count as number} via=db`,
    );
    res.redirect(302, targetUrl);
  }

  @Get('a/:id')
  @ApiOperation({
    summary: '관광지 클릭 추적 후 구글맵으로 이동',
    description:
      '관광지 줄 링크가 가리키는 곳. `attractions.click_count` 를 올리고 302 로 보낸다.\n\n' +
      '⚠️ **주소가 `/r/{clickId}` 와 달리 관광지별로 고정이다.** 호텔·항공권의 clickId 는 ' +
      '애드픽 subid 로 링크에 박혀서 노출마다 달라야 하지만, 관광지는 변환이 없어 그럴 ' +
      '이유가 없다. 그래서 단톡방에 오래 남은 카드의 링크도 안 죽는다.\n\n' +
      'DB 왕복은 한 번이다 (register_attraction_click 이 조회·증가·재료 반환을 동시에 한다).',
  })
  @ApiParam({ name: 'id', description: 'attractions.id' })
  @ApiResponse({ status: 302, description: '구글맵 검색 주소로 이동' })
  @ApiResponse({ status: 404, description: '없거나 지워진 관광지' })
  async attraction(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    // ⚠️ **인메모리 빠른 길을 두지 않는다.** 목적지를 알려면 이름과 도시가 필요한데,
    //    그걸 미리 담아두면 한 번의 카드 노출이 스무 칸을 차지한다 — 2000칸짜리
    //    공용 LRU 라서 수수료가 걸린 호텔 항목을 밀어낸다. 그쪽을 살리는 게 낫고,
    //    이 경로는 어차피 RPC 한 번(따뜻한 연결 ~90ms)으로 끝난다.
    const row = await this.attractions.registerClick(id);
    const name = (row?.attraction_name as string) ?? '';

    if (!name) {
      // 관리 화면에서 지웠거나 DB 가 꺼져 있다. 사용자가 할 수 있는 일은 같다.
      this.logger.warn(`unknown attraction id=${id}`);
      res.status(404).type('html').send(GONE_HTML);
      return;
    }

    // ⚠️ **주소를 여기서 만든다.** 노출 시점 값을 스냅샷해두지 않는 것이 요점이라
    //    (0012), 관리 화면에서 이름을 고치면 다음 클릭부터 새 이름으로 검색된다.
    const cityName = (row?.city_name as string) ?? null;
    const domestic = isDomestic(cityName);
    const targetUrl = domestic ? kakaoMapUrl(name, cityName) : mapsUrl(name, cityName);

    this.logger.log(
      `click attraction=${id} name=${name} count=${row?.clicks as number} ` +
        `map=${domestic ? 'kakao' : 'google'} via=db`,
    );
    res.redirect(302, targetUrl);
  }
}

/**
 * 국내 관광지인가. **모르면 false** — 그때는 구글맵으로 간다.
 *
 * 카카오맵은 해외 데이터가 거의 없어서 "모르겠으면 카카오맵" 은 빈 결과를 띄운다.
 * 반대로 구글맵은 국내도 되므로, 모를 때 틀려도 손해가 작은 쪽이 구글맵이다.
 *
 * ⚠️ **세부 지역은 여기서 false 가 된다(의도한 것이다).** `register_attraction_click`
 *    의 city_name 은 부모가 있으면 `"도톤보리 오사카"` 처럼 둘을 붙여서 준다
 *    (0012 — 노출 때 만든 링크와 같은 주소가 나와야 해서 `searchName()` 과 규칙을
 *    맞춘 것이다). `lookupCity` 는 전체 일치만 보므로 그런 값은 null 이 되고,
 *    결과적으로 구글맵으로 간다. "해운대 부산" 이 카카오맵을 못 타는 건 아쉽지만
 *    빈손보다 낫고, 지금 `attractions` 는 전부 도시 직속이라 실제로 걸릴 일이 없다.
 *
 * ⚠️ DB 가 아니라 사전을 본다. `places.country_code` 는 현재 **전부 null** 이고,
 *    채운다 해도 이 경로에 DB 왕복을 하나 더 붙이게 된다 (사용자가 302 를 기다린다).
 */
function isDomestic(cityName: string | null): boolean {
  return lookupCity(cityName)?.country === 'KR';
}

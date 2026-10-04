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
    const domestic = isDomestic(cityName, (row?.country_code as string) ?? null);
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
 * **재료가 둘인데 커버리지가 엇갈려서 둘 다 본다.** 등록 경로가 둘이기 때문이다 —
 * 사전 경로는 `countryCode: null` 로 넣고, 모델 경로는 모델이 준 값을 채운다
 * ([places.service.ts](../places/places.service.ts)).
 *
 *   사전(city-table)   서울·부산 등 21곳     DB 왕복 0, 판정이 매번 같다
 *   DB(country_code)   춘천·목포 등 새 도시   사전에 없는 도시를 여기가 받는다
 *
 * 사전만 보면 새로 등록된 국내 도시가 구글맵으로 가고, DB 만 보면 기존 116곳이
 * 그렇게 된다. ⚠️ **둘 중 하나를 지우지 마라** — 지금 `places` 116행이 전부
 * country_code null 인 걸 보고 "DB 는 쓸모없다" 고 판단하기 쉬운데, 그건 그 116곳이
 * 전부 씨앗(사전)으로 들어왔기 때문이지 컬럼이 안 쓰여서가 아니다.
 *
 * DB 값은 **모델이 준 것이라 틀릴 수 있다.** 틀려도 손해는 작다 — 한국이 아닌 곳이
 * 'KR' 로 들어와야 빈 카카오맵이 뜨는데, 그건 모델이 도시 자체를 잘못 안 경우라
 * 더 큰 문제가 먼저 드러난다.
 *
 * 세부 지역("해운대 부산")은 `lookupCity` 가 전체 일치만 봐서 null 이지만,
 * RPC 가 부모의 country_code 를 폴백으로 주므로(0014) 국내로 잡힌다.
 */
function isDomestic(cityName: string | null, countryCode: string | null): boolean {
  return countryCode === 'KR' || lookupCity(cityName)?.country === 'KR';
}

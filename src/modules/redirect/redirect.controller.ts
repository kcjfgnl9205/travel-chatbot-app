import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { MemoryStoreService } from '../database/memory-store.service';
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

@ApiTags('리다이렉트')
@Controller()
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);

  constructor(
    private readonly items: RecommendationItemsRepository,
    private readonly memory: MemoryStoreService,
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
}

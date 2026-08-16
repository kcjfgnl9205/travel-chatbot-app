import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import { Response } from 'express';

import { MemoryStoreService } from '../database/memory-store.service';
import { RecommendationItemsRepository } from '../database/repositories/recommendations.repository';

/**
 * 클릭 추적 리다이렉트.
 *
 * 카카오 listCard 의 줄 링크가 가리키는 곳. 여기를 한 번 거쳐야
 * "사용자가 어떤 호텔을 눌렀는지"를 DB에 남길 수 있다.
 *
 * DB 왕복은 **한 번**이다. register_click() 함수가 조회·카운터 증가·목적지 반환을
 * 동시에 한다. 사용자가 302 를 기다리는 경로라 왕복 수가 곧 체감 지연이다.
 */
const EXPIRED_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>링크를 찾을 수 없어요</title></head>
<body style="font-family:-apple-system,sans-serif;padding:48px 24px;text-align:center">
<h2>링크가 만료되었어요</h2>
<p>챗봇에서 호텔을 다시 추천받아 주세요.</p>
</body></html>`;

@Controller()
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);

  constructor(
    private readonly items: RecommendationItemsRepository,
    private readonly memory: MemoryStoreService,
  ) {}

  @Get('r/:clickId')
  async redirect(@Param('clickId') clickId: string, @Res() res: Response): Promise<void> {
    // DB 가 없거나 실패하면 인메모리 폴백으로 떨어진다 (로컬 개발용).
    const row = await this.items.registerClick(clickId);
    const fallback = row ? null : this.memory.registerClick(clickId);

    const targetUrl = (row?.target_url as string) ?? fallback?.targetUrl ?? null;
    const hotelName = (row?.hotel_name as string) ?? fallback?.hotelName ?? null;
    const clickCount = (row?.click_count as number) ?? fallback?.clickCount ?? null;

    if (!targetUrl) {
      this.logger.warn(`unknown clickId=${clickId}`);
      res.status(404).type('html').send(EXPIRED_HTML);
      return;
    }

    this.logger.log(`click clickId=${clickId} hotel=${hotelName} count=${clickCount}`);
    res.redirect(302, targetUrl);
  }
}

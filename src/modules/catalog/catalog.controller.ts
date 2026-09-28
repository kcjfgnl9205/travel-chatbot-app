import {
  Controller,
  Headers,
  Inject,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AppConfig, CONFIG } from '../../config/app.config';
import { CatalogService } from './catalog.service';

/**
 * 씨앗 도시 등록.
 *
 * **0009 에서 관광지 배치가 없어지고 이 하나만 남았다.** 예전에는 크론이 매일
 * `/refresh` 를 때려 구글에서 관광지를 받아왔는데, 목록이 우리 DB 로 오면서
 * 미리 채울 것이 사라졌다 — 크론도 같이 없앨 수 있다.
 *
 * ⚠️ **진단·관리 API 와 같은 토큰을 쓴다.** 운영자만 부르는 경로이고, 토큰을 하나 더
 *    두면 운영에서 관리할 비밀이 하나 더 생긴다. DEBUG_TOKEN 이 비어 있으면 404 다.
 */
@ApiTags('배치')
@ApiHeader({
  name: 'X-Debug-Token',
  required: false,
  description: 'DEBUG_TOKEN 을 설정한 경우 필수. 비어 있으면 이 경로는 404 다.',
})
@Controller('api/v1/catalog')
export class CatalogController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly catalog: CatalogService,
  ) {}

  @Post('seed')
  @ApiOperation({
    summary: '씨앗 도시를 places 에 등록한다 (한 번만)',
    description:
      '`places` 는 원래 "쓰면서 자라는" 테이블이라 아무도 안 물은 도시는 행이 없다. ' +
      '**관리 화면에서 관광지를 넣으려면 도시 행이 먼저 있어야 해서** 사전에서 씨를 뿌린다.\n\n' +
      '**모델을 부르지 않는다** — 사전에 있는 도시는 표준명이 이미 있다.\n\n' +
      '⚠️ `stored` 가 0 이면 DB 자격증명 문제다. `seeded` 는 메모리 폴백으로도 올라간다.',
  })
  @ApiResponse({ status: 201, description: '등록을 시도한 수와 DB 에 실제로 있는 도시 수' })
  async seed(
    @Headers('x-debug-token') token?: string,
  ): Promise<{ seeded: number; stored: number | null }> {
    this.authorize(token);
    return this.catalog.seed();
  }

  private authorize(token?: string): void {
    const expected = this.config.debugToken;
    if (!expected) throw new NotFoundException();
    if (!token || !safeEqual(token, expected)) throw new UnauthorizedException();
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

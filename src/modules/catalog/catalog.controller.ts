import {
  Body,
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
 * 관광지 목록을 미리 채우는 **배치 진입점.**
 *
 * ⚠️ **스케줄러를 앱에 두지 않는다.** 서버가 여러 대여도 배치는 하나만 돌아야 하는데,
 *    그 조율은 앱이 아니라 운영이 한다(크론 한 대에서만 때리면 된다). 앱에 타이머를
 *    넣으면 인스턴스 수만큼 같은 도시를 찾고, 그게 그대로 API 요금이 된다.
 *
 * ⚠️ **진단과 같은 토큰을 쓴다.** 둘 다 운영자만 부르는 경로이고, 토큰을 하나 더 두면
 *    운영에서 관리할 비밀이 하나 더 생긴다. DEBUG_TOKEN 이 비어 있으면 404 다.
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
      '미리 채우려면 대상 목록이 있어야 해서 도시 사전에서 씨를 뿌린다.\n\n' +
      '**모델을 부르지 않는다** — 사전에 있는 도시는 표준명이 이미 있다.',
  })
  @ApiResponse({ status: 201, description: '등록된 도시 수' })
  async seed(@Headers('x-debug-token') token?: string): Promise<{ seeded: number }> {
    this.authorize(token);
    return this.catalog.seed();
  }

  @Post('refresh')
  @ApiOperation({
    summary: '갱신할 때가 된 도시의 관광지 목록을 채운다 (크론이 하루 한 번)',
    description:
      '마지막 갱신이 `ATTRACTION_REFRESH_DAYS`(기본 28일)보다 오래된 도시를 골라 ' +
      '구글에서 목록을 다시 받고 모델이 순서를 정한다.\n\n' +
      '⚠️ **캐시 TTL(30일)보다 짧은 주기로 돌아야 한다.** 만료된 뒤에 갱신하면 그 도시의 ' +
      '첫 질문이 다시 대기를 타므로 미리 채워두는 의미가 없다.\n\n' +
      '한 도시가 실패해도 나머지는 계속한다. 만료된 관광지 캐시도 같이 지운다 — ' +
      '구글 콘텐츠라 30일이 지나면 실제로 지워야 한다.',
  })
  @ApiResponse({ status: 201, description: '갱신한 도시와 실패한 도시' })
  async refresh(
    @Body() body: { limit?: number },
    @Headers('x-debug-token') token?: string,
  ): Promise<{ refreshed: string[]; failed: string[] }> {
    this.authorize(token);
    // 하루치 기본값. 도시 112곳을 28일에 나누면 하루 4곳이다.
    return this.catalog.refreshDue(body?.limit ?? 4);
  }

  private authorize(token?: string): void {
    const expected = this.config.debugToken;
    if (!expected) throw new NotFoundException();
    if (!token || !safeEqual(token, expected)) throw new UnauthorizedException();
  }
}

/** 길이가 달라도 타이밍이 새지 않게 비교한다. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AppConfig, CONFIG } from '../../config/app.config';
import { ResetBody } from './maintenance.dto';
import { MaintenanceService, ResetPreview, ResetResult } from './maintenance.service';

/**
 * 서비스 데이터 초기화. **되돌릴 수 없는 유일한 경로다.**
 *
 * 관문이 셋이고, 순서대로 걸린다.
 *
 *   1. `DEBUG_TOKEN` 이 비어 있으면 **404** — 토큰을 안 정한 서버에 이 경로가 열려
 *      있는 것보다 없는 게 낫다 (관리·진단 API 와 같은 규칙).
 *   2. 토큰이 틀리면 **401**.
 *   3. 본문의 `confirm` 이 DB 이름과 다르면 **400**. DB 를 건드리기 전에 걸린다.
 *
 * ⚠️ **진단·관리 API 와 같은 토큰을 쓴다(DEBUG_TOKEN).** 토큰을 하나 더 두면 운영에서
 *    관리할 비밀이 하나 더 생긴다. 대신 3번을 둬서 토큰 하나로 지워지지 않게 했다.
 */
@ApiTags('운영 정비')
@ApiHeader({
  name: 'X-Debug-Token',
  required: false,
  description: 'DEBUG_TOKEN 을 설정한 경우 필수. 비어 있으면 이 경로는 404 다.',
})
@Controller('api/v1/admin/reset')
export class MaintenanceController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '무엇이 얼마나 지워지는지 미리 센다 (지우지 않는다)',
    description:
      '지울 테이블과 남길 테이블의 **현재 행 수**를 돌려준다. ' +
      '`database` 가 POST 의 `confirm` 에 적어야 하는 값이다.\n\n' +
      '⚠️ `COUNT(*)` 는 전체 훑기라 로그가 수백만 행이면 몇 초 걸린다.',
  })
  @ApiResponse({ status: 200, description: '테이블별 현재 행 수' })
  async preview(@Headers('x-debug-token') token?: string): Promise<ResetPreview> {
    this.authorize(token);
    return this.maintenance.preview();
  }

  @Post()
  @ApiBody({ type: ResetBody })
  @ApiOperation({
    summary: '행동 로그와 캐시를 전부 비운다 — 되돌릴 수 없다',
    description:
      '`users` · `messages` · `recommendations` · `recommendation_items` · ' +
      '`affiliate_links` · `search_results` · `intent_cache` 를 비우고, ' +
      '프로세스 안의 캐시도 같이 비운다.\n\n' +
      '**`places` · `place_aliases` · `attractions` 는 건드리지 않는다.** ' +
      '지역·관광지는 쌓인 게 아니라 만든 것이라 다시 만드는 비용이 전혀 다르다 ' +
      '(관광지는 도시 116곳 × 최대 20곳을 일회성 작업으로 채운 결과다).\n\n' +
      '⚠️ **이미 단톡방에 나간 카드의 링크가 죽는다.** `/r/{click_id}` 가 ' +
      '"링크가 만료되었어요" 페이지로 간다.\n\n' +
      '⚠️ 중간에 실패하면 되돌리지 않고 **어디까지 비웠는지**를 500 본문에 담아 올린다. ' +
      '같은 요청을 다시 보내면 이어서 비운다.',
  })
  @ApiResponse({ status: 201, description: '지운 행 수와 그대로 둔 테이블의 행 수' })
  @ApiResponse({ status: 400, description: 'confirm 이 DB 이름과 다르다 — 아무것도 지우지 않았다' })
  @ApiResponse({ status: 503, description: 'DB 에 접속할 수 없다 — 아무것도 지우지 않았다' })
  async reset(
    @Body() body: ResetBody,
    @Headers('x-debug-token') token?: string,
  ): Promise<ResetResult> {
    this.authorize(token);

    // ⚠️ **DB 를 건드리기 전에 본다.** 미리보기(COUNT)조차 돌리지 않는다 — 틀린
    //    confirm 으로 수백만 행을 세느라 몇 초를 쓸 이유가 없다.
    const expected = this.config.mysqlDatabase;
    if (body?.confirm !== expected) {
      throw new BadRequestException(
        'confirm 에 DB 이름을 그대로 적는다. GET /api/v1/admin/reset 의 database 값이다',
      );
    }

    return this.maintenance.reset();
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

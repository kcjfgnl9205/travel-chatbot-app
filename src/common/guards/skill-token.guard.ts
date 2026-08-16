import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { AppConfig, CONFIG } from '../../config/app.config';

/**
 * KAKAO_SKILL_TOKEN 을 설정한 경우에만 검증한다.
 *
 * 카카오 스킬 서버는 URL만 알면 아무나 호출할 수 있으므로,
 * 운영에서는 오픈빌더 스킬 헤더에 토큰을 넣고 이 값을 채우는 걸 권장.
 * 비워두면 검증을 아예 건너뛴다 (로컬 개발 편의).
 */
@Injectable()
export class SkillTokenGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.kakaoSkillToken;
    if (!expected) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const got = req.header('x-skill-token');
    if (got !== expected) throw new UnauthorizedException('invalid skill token');
    return true;
  }
}

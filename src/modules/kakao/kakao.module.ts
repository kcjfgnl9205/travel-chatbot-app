import { Module } from '@nestjs/common';

import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import { IntentModule } from '../intent/intent.module';
import { PlacesModule } from '../places/places.module';
import { SearchModule } from '../search/search.module';
import { RouterController } from './router.controller';

/**
 * 카카오 진입점. **엔드포인트가 하나뿐이다** (`POST /api/v1/kakao/router`).
 *
 * 호텔·항공권·관광지 엔드포인트는 없앴다 — 오픈빌더에 블록이 없어서 아무도 부를 수
 * 없고, 열어두면 "쓰이지 않는데 살아 있는 경로" 가 된다. 도메인 서비스는 그대로 남아
 * SearchService 가 내부에서 부른다.
 */
@Module({
  imports: [IntentModule, PlacesModule, SearchModule],
  controllers: [RouterController],
  providers: [SkillTokenGuard],
})
export class KakaoModule {}

import { Module } from '@nestjs/common';

import { OpenAiModule } from '../openai/openai.module';
import { PlacesService } from './places.service';

/**
 * 지역 정규화. 캐시 키가 여기서 나오므로 검색 비용이 이 모듈의 정확도에 달려 있다.
 *
 * 리포지토리(PlacesRepository / PlaceAliasesRepository)는 DatabaseModule 이 @Global 로
 * 내보낸다 — 여기서 다시 등록하면 인스턴스가 둘이 된다.
 */
@Module({
  imports: [OpenAiModule],
  providers: [PlacesService],
  exports: [PlacesService],
})
export class PlacesModule {}

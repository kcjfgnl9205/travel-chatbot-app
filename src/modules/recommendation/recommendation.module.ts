import { Module } from '@nestjs/common';

import { RecommendationRowsService } from './rows.service';

/**
 * 노출 기록 + 클릭 링크 발급. 세 도메인이 공유한다.
 *
 * **imports 가 비어 있다.** 필요한 건 CONFIG 와 레포지토리·인메모리 스토어뿐이고
 * 셋 다 전역 모듈이라 끌어올 게 없다. 특히 AffiliateModule 을 여기서 import 하지
 * 않는 것이 중요하다 — 그러면 관광지가 쓰지도 않는 제휴 모듈을 떠안게 되고,
 * "관광지에는 제휴 단계가 없다" 는 사실이 모듈 그래프에서 사라진다.
 */
@Module({
  providers: [RecommendationRowsService],
  exports: [RecommendationRowsService],
})
export class RecommendationModule {}

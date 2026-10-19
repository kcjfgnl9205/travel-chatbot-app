import { Module } from '@nestjs/common';

import { AffiliateModule } from '../affiliate/affiliate.module';
import { RedirectController } from './redirect.controller';

/**
 * /r/{clickId} — 클릭을 세고 **그 자리에서 커미션 링크를 만들어** 302 한다.
 *
 * ⚠️ AffiliateModule 이 여기 붙은 것이 0015 의 요점이다. 예전에는 카드를 만드는
 *    쪽(호텔·항공권)이 줄마다 미리 변환했는데, 눌리는 줄은 많아야 하나인데 전부
 *    변환했고 캐시가 빗나가면 카카오 5초 예산에서 2초를 먹었다.
 */
@Module({ imports: [AffiliateModule], controllers: [RedirectController] })
export class RedirectModule {}

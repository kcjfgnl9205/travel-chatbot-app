import { Module } from '@nestjs/common';

import { RedirectController } from './redirect.controller';

/** /r/{clickId} — 클릭 카운트 후 제휴 주소로 302. */
@Module({ controllers: [RedirectController] })
export class RedirectModule {}

import { Module } from '@nestjs/common';

import { AdpickService } from './adpick.service';

/** 애드픽 커미션 링크 생성. 키 마스킹과 동시 호출 상한을 여기서 책임진다. */
@Module({ providers: [AdpickService], exports: [AdpickService] })
export class AdpickModule {}

import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HotelService } from '../hotel/hotel.service';
import * as t from './templates';
import { KakaoSkillPayload, utteranceOf } from './dto/skill-payload.dto';
import { CITIES, hasCity, parse } from '../nlu/nlu';
import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import { SKILL_REQUEST_EXAMPLE, SKILL_RESPONSE_EXAMPLE } from './dto/skill-request.example';

@ApiTags('카카오 스킬')
@ApiHeader({
  name: 'X-Skill-Token',
  required: false,
  description:
    'KAKAO_SKILL_TOKEN 을 설정한 경우에만 검증한다. 로컬(.env 비어 있음)에서는 비워두면 된다.',
})
@Controller('api/v1/kakao')
@UseGuards(SkillTokenGuard)
export class KakaoController {
  private readonly logger = new Logger(KakaoController.name);

  constructor(private readonly hotels: HotelService) {}

  /**
   * 오픈빌더 [호텔추천] 블록 스킬.
   *
   * 어떤 예외가 나도 카카오에는 200 + 안내 문구를 돌려준다.
   * 500을 내면 사용자에게 "오류가 발생했습니다"만 뜨고 원인 추적이 어렵다.
   */
  @Post('hotels/recommend')
  @ApiOperation({
    summary: '호텔 추천',
    description:
      '오픈빌더 [호텔추천] 블록이 호출한다. 도시를 못 알아들으면 되묻기 응답을 돌려준다.\n' +
      '어떤 예외가 나도 200 + 안내 문구를 반환한다 (카카오에 500 을 주면 원인 불명 오류만 뜬다).',
  })
  @ApiBody({ description: '오픈빌더 스킬 페이로드', examples: { 오사카: { value: SKILL_REQUEST_EXAMPLE } } })
  @ApiResponse({ status: 201, description: 'listCard 한 장', schema: { example: SKILL_RESPONSE_EXAMPLE } })
  async recommend(@Body() payload: KakaoSkillPayload): Promise<t.Json> {
    try {
      return await this.hotels.handle(payload ?? {});
    } catch (err) {
      this.logger.error(
        `hotel recommend failed: utterance=${JSON.stringify(utteranceOf(payload ?? {}))} err=${err}`,
      );
      return t.simpleText(
        '일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏',
        CITIES.map((c) => t.quickReply(`${c.nameKo} 호텔`, `${c.nameKo} 호텔 추천해줘`)),
      );
    }
  }

  /** 폴백 블록. 도시가 섞여 있으면 안내 문구를 도시에 맞춰준다. */
  @Post('fallback')
  @ApiOperation({
    summary: '폴백 블록',
    description: '발화에 도시가 섞여 있으면 안내 문구를 그 도시에 맞춰준다.',
  })
  @ApiBody({ description: '오픈빌더 스킬 페이로드', examples: { 안녕: { value: SKILL_REQUEST_EXAMPLE } } })
  fallback(@Body() payload: KakaoSkillPayload): t.Json {
    const parsed = parse(utteranceOf(payload ?? {}));
    const text = hasCity(parsed)
      ? `${parsed.cityName} 호텔을 찾으시나요? 아래 버튼을 눌러보세요!`
      : '아직은 호텔 추천만 도와드릴 수 있어요.\n예) 오사카 호텔 추천해줘';

    return t.simpleText(
      text,
      CITIES.map((c) => t.quickReply(`${c.nameKo} 호텔`, `${c.nameKo} 호텔 추천해줘`)),
    );
  }
}

import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HotelService } from '../hotel/hotel.service';
import * as t from './templates';
import { KakaoSkillPayload, utteranceOf } from './dto/skill-payload.dto';
import { CITIES, hasCity } from '../nlu/nlu';
import { NluService } from '../nlu/nlu.service';
import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import {
  ASK_CITY_EXAMPLE,
  CALLBACK_ACK_EXAMPLE,
  SEARCH_STARTED_EXAMPLE,
  SKILL_REQUEST_EXAMPLE,
  SKILL_REQUEST_WITH_CALLBACK_EXAMPLE,
  SKILL_RESPONSE_EXAMPLE,
} from './dto/skill-request.example';

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

  constructor(
    private readonly hotels: HotelService,
    private readonly nlu: NluService,
  ) {}

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
      '오픈빌더 [호텔추천] 블록이 호출한다.\n\n' +
      '**응답이 한 종류가 아니다.** 호텔 검색은 gpt-5-mini + 웹 검색이라 7~30초가 걸리는데 ' +
      '카카오는 5초 안에 응답을 받아야 한다. 그래서 캐시에 있을 때만 카드가 바로 나가고, ' +
      '없으면 검색을 백그라운드로 돌린 뒤 콜백으로 밀어준다.\n\n' +
      '| 상황 | 응답 |\n' +
      '|---|---|\n' +
      '| 캐시 히트 | `listCard` 즉시 |\n' +
      '| 캐시 미스 + 콜백 켜짐 | `useCallback` → 잠시 뒤 callbackUrl 로 카드 POST |\n' +
      '| 캐시 미스 + 콜백 꺼짐 | "찾고 있어요" 안내. 다시 물으면 카드 |\n' +
      '| 도시 못 알아들음 | 되묻기 |\n\n' +
      '⚠️ **스웨거에서 Execute 하면 대개 "찾고 있어요" 가 나온다.** 실패가 아니라 정상이다 — ' +
      '같은 요청을 한 번 더 보내면 카드가 나온다. 두 번째도 안 나오면 서버 로그를 봐야 한다 ' +
      '(OPENAI_API_KEY 누락 등은 응답이 아니라 로그에만 남는다).\n\n' +
      '어떤 예외가 나도 200/201 + 안내 문구를 반환한다 (카카오에 500 을 주면 원인 불명 오류만 뜬다).',
  })
  @ApiBody({
    description: '오픈빌더 스킬 페이로드',
    examples: {
      오사카: { summary: '기본 (콜백 없음)', value: SKILL_REQUEST_EXAMPLE },
      콜백: {
        summary: '콜백 켜진 블록 (callbackUrl 포함)',
        value: SKILL_REQUEST_WITH_CALLBACK_EXAMPLE,
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: '상황에 따라 넷 중 하나',
    content: {
      'application/json': {
        examples: {
          검색중: {
            summary: '캐시 미스 + 콜백 꺼짐 — 스웨거에서 보통 이게 나온다',
            value: SEARCH_STARTED_EXAMPLE,
          },
          콜백예약: { summary: '캐시 미스 + 콜백 켜짐', value: CALLBACK_ACK_EXAMPLE },
          카드: { summary: '캐시 히트', value: SKILL_RESPONSE_EXAMPLE },
          되묻기: { summary: '도시를 못 알아들음', value: ASK_CITY_EXAMPLE },
        },
      },
    },
  })
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
    // peek 은 별칭 캐시만 본다 — 모델을 부르지 않는다.
    // 폴백 블록은 인사말·잡담이 대부분이라, 여기서 파싱에 돈을 쓸 이유가 없다.
    const parsed = this.nlu.peek(utteranceOf(payload ?? {}));
    const text = hasCity(parsed)
      ? `${parsed.cityName} 호텔을 찾으시나요? 아래 버튼을 눌러보세요!`
      : '아직은 호텔 추천만 도와드릴 수 있어요.\n예) 오사카 호텔 추천해줘';

    return t.simpleText(
      text,
      CITIES.map((c) => t.quickReply(`${c.nameKo} 호텔`, `${c.nameKo} 호텔 추천해줘`)),
    );
  }
}

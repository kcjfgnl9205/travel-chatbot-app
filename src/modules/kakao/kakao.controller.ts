import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AttractionService } from '../attraction/attraction.service';
import { FlightService } from '../flight/flight.service';
import { HotelService } from '../hotel/hotel.service';
import * as t from './templates';
import { KakaoSkillPayload, utteranceOf } from './dto/skill-payload.dto';
import { CITIES, hasCity } from '../nlu/nlu';
import { FlightNluService, hasRoute } from '../nlu/flight-nlu.service';
import { NluService } from '../nlu/nlu.service';
import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import {
  ASK_ATTRACTION_CITY_EXAMPLE,
  ASK_CITY_EXAMPLE,
  ASK_ROUTE_EXAMPLE,
  ATTRACTION_CALLBACK_ACK_EXAMPLE,
  ATTRACTION_REQUEST_EXAMPLE,
  ATTRACTION_REQUEST_WITH_CALLBACK_EXAMPLE,
  ATTRACTION_RESPONSE_EXAMPLE,
  ATTRACTION_SEARCH_STARTED_EXAMPLE,
  CALLBACK_ACK_EXAMPLE,
  FLIGHT_CALLBACK_ACK_EXAMPLE,
  FLIGHT_REQUEST_EXAMPLE,
  FLIGHT_REQUEST_WITH_CALLBACK_EXAMPLE,
  FLIGHT_RESPONSE_EXAMPLE,
  FLIGHT_SEARCH_STARTED_EXAMPLE,
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
    private readonly flights: FlightService,
    private readonly attractions: AttractionService,
    private readonly nlu: NluService,
    private readonly flightNlu: FlightNluService,
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

  /**
   * 오픈빌더 [항공권검색] 블록 스킬.
   *
   * 호텔과 응답 형태가 다르다 — **itemCard 캐러셀**이다. 이유는 listCard 의 한 줄
   * 40자에 항공사·편명·출발/도착 시각·소요·경유·가격이 들어가지 않기 때문이다.
   *
   * 어떤 예외가 나도 카카오에는 200 + 안내 문구를 돌려준다.
   */
  @Post('flights/search')
  @ApiOperation({
    summary: '항공권 검색',
    description:
      '오픈빌더 [항공권검색] 블록이 호출한다.\n\n' +
      '**응답 형태가 호텔과 다르다.** 항공권 1건은 listCard 한 줄(40자)에 안 들어가므로 ' +
      '`itemCard` 를 캐러셀로 보낸다. 캐러셀에는 header 자리가 없어서 노선·조건·' +
      '"가격은 검색 시점 기준" 같은 공통 맥락은 앞에 `simpleText` 하나를 세워 전달한다.\n\n' +
      '**응답이 한 종류가 아니다.** 호텔과 같은 이유다 — 검색이 7~30초인데 카카오는 5초 안에 ' +
      '응답을 받아야 한다.\n\n' +
      '| 상황 | 응답 |\n' +
      '|---|---|\n' +
      '| 캐시 히트 | `simpleText` + `itemCard` 캐러셀 즉시 |\n' +
      '| 캐시 미스 + 콜백 켜짐 | `useCallback` → 잠시 뒤 callbackUrl 로 카드 POST |\n' +
      '| 캐시 미스 + 콜백 꺼짐 | "찾고 있어요" 안내. 다시 물으면 카드 |\n' +
      '| 목적지 못 알아들음 | 되묻기 |\n\n' +
      '⚠️ **가격은 확정 운임이 아니다.** 실시간 운임 API 가 아니라 웹 검색 결과다. ' +
      '카드에 \'예상가\' 로 적고 안내 말풍선에도 명시한다 — 실제 금액은 예약 페이지에서 확인된다.\n\n' +
      '⚠️ **출발지를 말하지 않으면 서울(ICN) 출발로 본다** (FLIGHT_DEFAULT_ORIGIN_*). ' +
      '되묻지 않는 대신 안내 말풍선에 "서울 출발 기준" 을 적어 고쳐 말할 수 있게 한다.\n\n' +
      '⚠️ **스웨거에서 Execute 하면 대개 "찾고 있어요" 가 나온다.** 실패가 아니라 정상이다 — ' +
      '같은 요청을 한 번 더 보내면 카드가 나온다. 카드를 바로 보려면 ' +
      '`/api/v1/debug/flight-search` 를 쓰면 된다 (동기로 끝까지 돌린다).',
  })
  @ApiBody({
    description: '오픈빌더 스킬 페이로드',
    examples: {
      오사카왕복: { summary: '기본 (콜백 없음)', value: FLIGHT_REQUEST_EXAMPLE },
      콜백: {
        summary: '콜백 켜진 블록 (callbackUrl 포함)',
        value: FLIGHT_REQUEST_WITH_CALLBACK_EXAMPLE,
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
            value: FLIGHT_SEARCH_STARTED_EXAMPLE,
          },
          콜백예약: { summary: '캐시 미스 + 콜백 켜짐', value: FLIGHT_CALLBACK_ACK_EXAMPLE },
          카드: { summary: '캐시 히트 — itemCard 캐러셀', value: FLIGHT_RESPONSE_EXAMPLE },
          되묻기: { summary: '목적지를 못 알아들음', value: ASK_ROUTE_EXAMPLE },
        },
      },
    },
  })
  async searchFlights(@Body() payload: KakaoSkillPayload): Promise<t.Json> {
    try {
      return await this.flights.handle(payload ?? {});
    } catch (err) {
      this.logger.error(
        `flight search failed: utterance=${JSON.stringify(utteranceOf(payload ?? {}))} err=${err}`,
      );
      return t.simpleText(
        '일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏',
        CITIES.map((c) => t.quickReply(`${c.nameKo} 항공권`, `${c.nameKo} 항공권 찾아줘`)),
      );
    }
  }

  /**
   * 오픈빌더 [관광지추천] 블록 스킬.
   *
   * 호텔과 같은 `listCard` 지만 **줄 링크의 목적지가 다르다** — 애드픽 커미션 링크가
   * 아니라 구글맵이다. 관광지는 우리가 파는 게 아니라 장소라서 변환할 주소가 없다.
   *
   * 어떤 예외가 나도 카카오에는 200 + 안내 문구를 돌려준다.
   */
  @Post('attractions/recommend')
  @ApiOperation({
    summary: '관광지 추천',
    description:
      '오픈빌더 [관광지추천] 블록이 호출한다.\n\n' +
      '**응답은 호텔과 같은 `listCard` 다.** 관광지 추천은 비교가 목적이라 5곳이 한 화면에 ' +
      '세로로 나열되는 게 맞다. 줄 전체가 클릭 영역이고, 누르면 `/r/{clickId}` 를 거쳐 ' +
      '**구글맵**으로 간다.\n\n' +
      '**제휴 링크를 타지 않는다.** 관광지는 예약할 게 없어 애드픽에 변환할 주소가 없다. ' +
      '지도 주소는 모델에게 받지 않고 **관광지 이름 + 도시로 서버가 직접 만든다** — ' +
      '그래서 이 도메인에는 모델이 URL 을 지어낼 위험이 아예 없다.\n\n' +
      '그래도 `/r/{clickId}` 는 거친다. 수수료는 없어도 **어떤 관광지를 눌렀는지**는 ' +
      '알아야 하기 때문이다 (카카오 링크는 브라우저를 바로 열어 우리 서버로 신호가 오지 않는다).\n\n' +
      '**응답이 한 종류가 아니다.** 호텔·항공권과 같은 이유다 — 검색이 7~30초인데 카카오는 ' +
      '5초 안에 응답을 받아야 한다.\n\n' +
      '| 상황 | 응답 |\n' +
      '|---|---|\n' +
      '| 캐시 히트 | `listCard` 즉시 |\n' +
      '| 캐시 미스 + 콜백 켜짐 | `useCallback` → 잠시 뒤 callbackUrl 로 카드 POST |\n' +
      '| 캐시 미스 + 콜백 꺼짐 | "찾고 있어요" 안내. 다시 물으면 카드 |\n' +
      '| 도시 못 알아들음 | 되묻기 |\n\n' +
      '캐시는 하루(`ATTRACTION_CACHE_TTL_MINUTES`)다. 호텔 요금·항공 운임과 달리 ' +
      '볼거리 목록은 어제와 오늘이 같아서, 짧게 잡으면 같은 답을 다시 사는 셈이 된다.\n\n' +
      '⚠️ **카드에 이미지가 없다.** 관광지는 긁어올 예약 페이지가 없어 썸네일 출처가 없다. ' +
      '(호텔은 예약 페이지에서 og:image 를 읽어 온다)\n\n' +
      '⚠️ **스웨거에서 Execute 하면 대개 "찾고 있어요" 가 나온다.** 실패가 아니라 정상이다 — ' +
      '같은 요청을 한 번 더 보내면 카드가 나온다. 카드를 바로 보려면 ' +
      '`/api/v1/debug/attraction-search` 를 쓰면 된다 (동기로 끝까지 돌린다).',
  })
  @ApiBody({
    description: '오픈빌더 스킬 페이로드',
    examples: {
      오사카: { summary: '기본 (콜백 없음)', value: ATTRACTION_REQUEST_EXAMPLE },
      콜백: {
        summary: '콜백 켜진 블록 (callbackUrl 포함)',
        value: ATTRACTION_REQUEST_WITH_CALLBACK_EXAMPLE,
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
            value: ATTRACTION_SEARCH_STARTED_EXAMPLE,
          },
          콜백예약: { summary: '캐시 미스 + 콜백 켜짐', value: ATTRACTION_CALLBACK_ACK_EXAMPLE },
          카드: { summary: '캐시 히트 — 줄 링크가 구글맵으로 간다', value: ATTRACTION_RESPONSE_EXAMPLE },
          되묻기: { summary: '도시를 못 알아들음', value: ASK_ATTRACTION_CITY_EXAMPLE },
        },
      },
    },
  })
  async recommendAttractions(@Body() payload: KakaoSkillPayload): Promise<t.Json> {
    try {
      return await this.attractions.handle(payload ?? {});
    } catch (err) {
      this.logger.error(
        `attraction recommend failed: utterance=${JSON.stringify(utteranceOf(payload ?? {}))} err=${err}`,
      );
      return t.simpleText(
        '일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏',
        CITIES.map((c) => t.quickReply(`${c.nameKo} 관광지`, `${c.nameKo} 관광지 추천해줘`)),
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
    const utterance = utteranceOf(payload ?? {});
    const parsed = this.nlu.peek(utterance);
    const flight = this.flightNlu.peek(utterance);

    // 항공권 캐시를 먼저 본다. "오사카 항공권" 은 두 파서 모두 오사카를 알지만
    // 사용자가 물은 건 항공권이므로, 호텔 안내를 내보내면 엉뚱한 답이 된다.
    const text = hasRoute(flight)
      ? `${flight.destName} 항공권을 찾으시나요? 아래 버튼을 눌러보세요!`
      : hasCity(parsed)
        ? `${parsed.cityName} 호텔을 찾으시나요? 아래 버튼을 눌러보세요!`
        : '호텔 · 항공권 · 관광지를 도와드릴 수 있어요.\n' +
          '예) 오사카 호텔 추천해줘 / 다음달 3일 오사카 왕복 항공권 / 오사카 관광지 추천해줘';

    // ⚠️ 퀵리플라이는 10개가 한계다. 도시 3개 × 3도메인 = 9개로 이제 거의 찼다.
    //    도메인이나 예시 도시를 하나 더 늘리면 잘려 나간다 (templates.ts 가 자른다).
    //    그때는 도시를 줄이거나, 도메인 선택 → 도시 선택 2단계로 바꿔야 한다.
    return t.simpleText(text, [
      ...CITIES.map((c) => t.quickReply(`${c.nameKo} 호텔`, `${c.nameKo} 호텔 추천해줘`)),
      ...CITIES.map((c) => t.quickReply(`${c.nameKo} 항공권`, `${c.nameKo} 항공권 찾아줘`)),
      ...CITIES.map((c) => t.quickReply(`${c.nameKo} 관광지`, `${c.nameKo} 관광지 추천해줘`)),
    ]);
  }
}

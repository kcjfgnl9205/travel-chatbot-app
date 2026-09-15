import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SkillTokenGuard } from '../../common/guards/skill-token.guard';
import { UsersRepository } from '../database/repositories/users.repository';
import { IntentService } from '../intent/intent.service';
import { TRAVEL_HINT, intentFromKeywords } from '../intent/intent.types';
import { PlacesService } from '../places/places.service';
import { SearchService } from '../search/search.service';
import { RouterRequest, SearchKind } from '../search/search.types';
import * as cards from './cards';
import * as t from './templates';
import { cacheKeyOf, needsCursorFallback, offsetOf } from './paging';
import { PendingAskMemory, isAnotherPlaceRequest, looksLikePlaceName } from './pending';
import {
  KakaoSkillPayload,
  blockIdOf,
  botNameOf,
  callbackUrlOf,
  userKeyOf,
  utteranceOf,
} from './dto/skill-payload.dto';
import {
  BUSY_EXAMPLE,
  CALLBACK_ACK_EXAMPLE,
  CARD_RESPONSE_EXAMPLE,
  HELP_RESPONSE_EXAMPLE,
  MORE_REQUEST_EXAMPLE,
  ROUTER_REQUEST_EXAMPLE,
  ROUTER_REQUEST_WITH_CALLBACK_EXAMPLE,
  SEARCH_STARTED_EXAMPLE,
} from './dto/router.example';

/**
 * **유일한 외부 진입점.**
 *
 * 오픈빌더에서 시나리오 블록·엔티티·대표 명령어를 전부 지웠다. 블록이 하나도 없으므로
 * 봇을 멘션한 모든 발화가 폴백으로 떨어지고, 폴백 블록이 이 엔드포인트 하나를 부른다.
 * 호텔·항공권·관광지는 이제 URL 이 아니라 **발화**로 갈린다.
 *
 *   1. 더보기 요청인가 (`clientExtra.cache_key`) → 저장된 행에서 잘라 즉시 반환. AI 0회
 *   2. 여행 신호가 있나 (정규식)            → 없으면 도움말 카드. AI 0회
 *   3. 의도·지역 추출                        → unknown 이면 도움말 / 되묻기
 *   4. 지역 정규화 → place_id
 *   5. 캐시 조회 → 히트면 1페이지, 미스면 선점 후 백그라운드 검색
 *
 * ⚠️ **어떤 예외가 나도 200 + 안내 문구를 돌려준다.** 카카오에 500 을 주면 사용자에게는
 *    원인 불명 오류만 뜨고, 단톡방에서는 그게 봇이 죽은 것처럼 보인다.
 */
@ApiTags('카카오 스킬')
@ApiHeader({
  name: 'X-Skill-Token',
  required: false,
  description:
    'KAKAO_SKILL_TOKEN 을 설정한 경우에만 검증한다. 로컬(.env 비어 있음)에서는 비워두면 된다.',
})
@Controller('api/v1/kakao')
@UseGuards(SkillTokenGuard)
export class RouterController {
  private readonly logger = new Logger(RouterController.name);
  /** "도시 이름만 보내주세요" 라고 해놓고 기다리는 사람들. 발화자별로 5분. */
  private readonly pending = new PendingAskMemory();

  constructor(
    private readonly intent: IntentService,
    private readonly places: PlacesService,
    private readonly search: SearchService,
    private readonly users: UsersRepository,
  ) {}

  @Post('router')
  @ApiOperation({
    summary: '여행메이트 라우터 (유일한 진입점)',
    description:
      '오픈빌더 **폴백 블록**이 호출한다. 블록이 하나도 없으므로 봇을 멘션한 모든 발화가 ' +
      '여기로 온다.\n\n' +
      '**응답이 한 종류가 아니다.** AI 검색은 7~30초인데 카카오는 5초 안에 응답을 받아야 한다. ' +
      '그래서 저장된 결과가 있을 때만 카드가 바로 나가고, 없으면 검색을 백그라운드로 돌린 뒤 ' +
      '콜백으로 밀어준다.\n\n' +
      '| 상황 | 응답 |\n' +
      '|---|---|\n' +
      '| 저장된 결과 있음 | `listCard` 5건 + 고지 말풍선 + 더보기 버튼 |\n' +
      '| 더보기 (`clientExtra.cache_key`) | 저장된 행에서 잘라 즉시. **AI 호출 0회** |\n' +
      '| 미스 + 콜백 켜짐 | `useCallback` → 잠시 뒤 callbackUrl 로 카드 POST |\n' +
      '| 미스 + 콜백 꺼짐 | "찾고 있어요". 다시 물으면 카드 |\n' +
      '| 다른 사람이 조회 중 | "먼저 찾고 있어요" |\n' +
      '| 여행 무관 / 의도 불명 | 도움말 카드 |\n\n' +
      '⚠️ **"잘못된 검색입니다" 같은 오류 문구를 쓰지 않는다.** 인사말·잡담까지 오류로 ' +
      '취급하면 단톡방이 딱딱해진다. 할 수 있는 세 가지를 예시와 함께 보여주는 것이 안내다.\n\n' +
      '⚠️ **날짜·인원은 검색에 반영되지 않는다.** 캐시를 지역(항공권은 노선·왕복여부)으로만 ' +
      '가르기 때문이다. 대신 카드 아래 말풍선에 반영하지 않았다는 사실을 반드시 적는다.\n\n' +
      '⚠️ **스웨거에서 Execute 하면 대개 "찾고 있어요" 가 나온다.** 실패가 아니라 정상이다 — ' +
      '같은 요청을 한 번 더 보내면 카드가 나온다.',
  })
  @ApiBody({
    description: '오픈빌더 스킬 페이로드',
    examples: {
      호텔: { summary: '기본 (콜백 없음)', value: ROUTER_REQUEST_EXAMPLE },
      콜백: { summary: '콜백 켜진 블록', value: ROUTER_REQUEST_WITH_CALLBACK_EXAMPLE },
      더보기: { summary: '더 보기 버튼 (AI 호출 0회)', value: MORE_REQUEST_EXAMPLE },
    },
  })
  @ApiResponse({
    status: 201,
    description: '상황에 따라 다섯 중 하나',
    content: {
      'application/json': {
        examples: {
          검색중: {
            summary: '미스 + 콜백 꺼짐 — 스웨거에서 보통 이게 나온다',
            value: SEARCH_STARTED_EXAMPLE,
          },
          콜백예약: { summary: '미스 + 콜백 켜짐', value: CALLBACK_ACK_EXAMPLE },
          카드: { summary: '저장된 결과 있음', value: CARD_RESPONSE_EXAMPLE },
          도움말: { summary: '여행 무관 / 의도 불명', value: HELP_RESPONSE_EXAMPLE },
          조회중: { summary: '다른 사람이 먼저 물어봄', value: BUSY_EXAMPLE },
        },
      },
    },
  })
  async route(@Body() payload: KakaoSkillPayload): Promise<t.Json> {
    const request = payload ?? {};
    try {
      return await this.dispatch(request);
    } catch (err) {
      this.logger.error(
        `router failed utterance=${JSON.stringify(utteranceOf(request))} err=${err}`,
      );
      // 무엇이 터졌든 사용자에게는 "다음에 뭘 물으면 되는지" 를 준다.
      return cards.helpCard();
    }
  }

  // ---------------------------------------------------------------- 내부
  private async dispatch(payload: KakaoSkillPayload): Promise<t.Json> {
    const req = await this.request(payload);

    // 1. 더보기 — AI 를 부르지 않고 저장된 행에서 잘라 보낸다.
    const cacheKey = cacheKeyOf(payload);
    if (cacheKey) return this.search.servePage(cacheKey, offsetOf(payload), req);

    // 1-b. 메시지 버튼 경로. 버튼이 커서를 못 실어서 서버가 기억해둔 걸 쓴다.
    if (needsCursorFallback(payload)) {
      const cursor = this.search.cursorOf(req.userKey);
      if (cursor) return this.search.servePage(cursor.cacheKey, cursor.offset, req);
    }

    // 2. 멘션만 있는 빈 발화 — "@여행메이트에게 말하기" 버튼이 (프리필 대신) 전송된 경우다.
    //    되묻던 중이었으면 그 흐름을 이어준다. 아니면 아래 1차 필터가 도움말을 준다.
    if (!req.utterance) {
      const waitingForCity = this.pending.take(req.userKey);
      if (waitingForCity) {
        this.pending.remember(req.userKey, waitingForCity);
        return cards.askPlaceNameOnly(waitingForCity.kind, waitingForCity.country, req.botName);
      }
    }

    // 2-a. "다른 도시" — 목록에 없는 도시를 가려는 사람의 출구.
    //    카카오에는 입력창을 미리 채우는 버튼이 없으므로, 한 번 되묻고 다음 발화를 받는다.
    if (isAnotherPlaceRequest(req.utterance)) {
      const kind = intentFromKeywords(req.utterance);
      if (kind !== 'unknown') {
        // 어느 나라를 고르다 왔는지 이어받는다 — "베트남 어디로 가세요?" 가
        // "어느 도시 호텔을 찾으세요?" 보다 맥락이 산다.
        const country = this.pending.take(req.userKey)?.country ?? null;
        this.pending.remember(req.userKey, { kind, country });
        return cards.askPlaceNameOnly(kind, country, req.botName);
      }
    }

    // 2-b. 되묻기에 대한 대답. **"다낭" 한 마디에는 여행 신호가 없으므로 1차 필터보다 먼저 본다.**
    const waiting = looksLikePlaceName(req.utterance) ? this.pending.take(req.userKey) : null;
    if (waiting) {
      const place = await this.places.resolve(req.utterance.trim());
      if (place && place.kind !== 'country') {
        this.logger.log(`pending answer "${req.utterance}" → ${waiting.kind}/${place.canonicalName}`);
        // 대기 상태를 되살린다. 콜백이 꺼져 있으면 사용자는 같은 말("다낭")을 한 번 더
        // 보내게 되는데, 그때 도움말이 나가면 대화가 끊긴다.
        this.pending.remember(req.userKey, waiting);
        return this.search.serve(
          { intent: waiting.kind, place: place.canonicalName, from: null, tripType: 'rt', ignored: [] },
          place,
          req,
        );
      }
      // 나라를 또 말했거나 못 알아들었다 — 다시 되묻는다(대기 상태를 되살린다).
      this.pending.remember(req.userKey, waiting);
      return cards.askPlaceNameOnly(waiting.kind, place?.canonicalName ?? null, req.botName);
    }

    // 3. 1차 필터 — 여행과 무관하면 AI 를 아예 부르지 않는다.
    if (!TRAVEL_HINT.test(req.utterance)) return cards.helpCard();

    // 4. 의도 + 지역.
    const parsed = await this.intent.extract(req.utterance);
    if (parsed.intent === 'unknown') return cards.helpCard();
    if (!parsed.place) return cards.askPlaceCard(parsed.intent as SearchKind);

    // 5. 지역 정규화. 모르는 지명도 등록해서 검색까지는 가본다.
    const place = await this.places.resolve(parsed.place);
    if (!place) return cards.askPlaceCard(parsed.intent as SearchKind);

    // 5-b. 나라를 말했으면 검색하지 않고 **그 나라의 도시**로 되묻는다.
    //      나라 단위 검색은 다낭·하노이가 섞인 목록이 되어 아무에게도 쓸모가 없다.
    if (place.kind === 'country') {
      const cities = await this.places.citiesOf(place);
      // "다른 도시" 를 누를 수 있게, 그 사람의 다음 발화를 지명으로 받을 준비를 해둔다.
      this.pending.remember(req.userKey, {
        kind: parsed.intent as SearchKind,
        country: place.canonicalName,
      });
      return cards.askCityInCountry(
        parsed.intent as SearchKind,
        place.canonicalName,
        cities,
        req.botName,
      );
    }

    // 6. 캐시 → 응답.
    return this.search.serve(parsed, place, req);
  }

  /** 요청 한 건의 맥락. 사용자 등록까지가 여기 책임이고, 메시지 로그는 검색 쪽이 남긴다. */
  private async request(payload: KakaoSkillPayload): Promise<RouterRequest> {
    const userKey = userKeyOf(payload);
    const user = await this.users.getOrCreate(userKey);
    return {
      utterance: utteranceOf(payload),
      userKey,
      userId: (user?.id as string) ?? null,
      callbackUrl: callbackUrlOf(payload),
      blockId: blockIdOf(payload),
      started: Date.now(),
      botName: botNameOf(payload),
    };
  }
}

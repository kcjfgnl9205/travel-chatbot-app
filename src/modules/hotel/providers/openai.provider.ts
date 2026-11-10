import { Inject, Injectable, Logger } from '@nestjs/common';

import { allowedHost, merchantFrom, toKoreanUrl } from '../../../common/booking-url';
import { fetchWithTimeout } from '../../../common/fetch';
import { bounded, positiveInt, text, textWithoutCitations } from '../../../common/parse';
import { AppConfig, CONFIG } from '../../../config/app.config';
import { OpenAiService } from '../../openai/openai.service';
import { TwoStageSearch, TwoStageTrace, newTwoStageTrace } from '../../openai/two-stage';
import { Hotel, HotelProvider, HotelQuery } from '../hotel.types';
import { isHotelDetailUrl } from '../search-url';
import { isGrounded, nameKey, nameMatchesTitle, pageTitleOf, sourceKeys } from '../verify';
import { extractThumbnail } from '../thumbnail';

/**
 * gpt-5-mini + 웹 검색으로 호텔을 찾는 provider.
 *
 *   1차 호출 : 웹 검색을 돌려 후보 10~20개를 긁는다 (구조화 JSON)
 *   2차 호출 : 후보를 조건·가격·위치·평점으로 비교해 상위 N개를 JSON 으로 뽑는다
 *
 * 왜 두 번 부르나 — 한 번에 시키면 모델이 검색 결과를 요약하는 데 힘을 쓰고
 * 비교/선별은 대충 한다. 검색과 판단을 갈라두면 각 단계를 따로 계측·디버깅할 수 있다.
 *
 * ⚠️ **두 호출 다 구조화 출력을 건다.** 1차를 자유 텍스트로 뒀더니 모델이
 *    "웹 검색을 진행해도 될까요? 날짜를 알려주세요" 라고 되묻고 끝나서 후보가 0개가 됐다.
 *    상대는 사람이 아니라 프로그램이라 그 질문에 답할 사람이 없다.
 *
 * ⚠️ 느리다(합쳐서 7~30초). 카카오 5초 예산 안에서 부르면 안 된다.
 *    HotelService 가 콜백/백그라운드에서만 호출한다.
 */

/**
 * 예약 링크로 인정하는 호스트. **트립닷컴 하나다.**
 *
 * 모델은 없는 URL 을 그럴듯하게 만들어낸다. 그게 애드픽 변환을 타고 사용자에게
 * 나가면 404 로 떨어진다. 호스트라도 걸러서 피해를 줄인다.
 *
 * ⚠️ **왜 한 곳만 남겼나 — 날짜·인원이 살아서 가는 곳이 여기뿐이다** (2026-11-10).
 *
 *     트립닷컴      ⭕ 애드픽을 거쳐도 유지된다 (실측)
 *     호텔스닷컴    ❌ 애드픽 → Partnerize 경유에서 쿼리가 통째로 날아간다
 *                      ([ISSUE 문서](../../../../docs/ISSUE-2026-11-09-HOTELS-COM-STAY.md))
 *     마이리얼트립  ❌ 제휴 링크가 「서비스 정책에 의해 차단」으로 막혔다 (BLOCKED_HOSTS)
 *     클룩          ❓ 확인한 적 없다. 호텔 상세가 검색에 잘 안 걸려 갈래도 없었다
 *
 *    날짜가 안 가는 줄이 하나라도 섞이면 **그 카드는 날짜를 아예 말하지 못한다**
 *    (`stayReachesUser`). 줄 수를 늘리자고 그 줄을 섞으면, 멀쩡한 트립닷컴 줄까지
 *    "날짜는 반영되지 않았어요" 를 달고 나간다 — 남는 장사가 아니다.
 *
 * ⚠️ 여기를 바꾸면 SEARCH_INSTRUCTIONS 와 HOTEL_SCHEMA 의 안내 문구도 같이 바꿔야 한다.
 *    모델에게 A 를 찾으라고 시켜놓고 B 만 통과시키면 결과가 전부 버려진다.
 */
export const ALLOWED_HOSTS = [
  'trip.com', // 트립닷컴
];

/**
 * **호텔에서 뺀 제휴몰.** 제휴 링크를 눌렀더니 「마이리얼트립은 서비스 정책에 의해 링크
 * 연결이 차단되었습니다」가 떴다(2026-11-09) — 수수료도 없고 사용자는 예약 페이지에
 * 못 간다. 검색도 하지 않고, **이미 저장된 행에서도 뺀다**(`HotelService.isItem`).
 *
 * ⚠️ 항공권은 별개다. 거기서도 막히는지는 따로 확인해야 한다.
 */
export const BLOCKED_HOSTS = ['myrealtrip.com'];

/** 차단된 제휴몰 주소인가. 캐시에 남은 옛 행을 거르는 데 쓴다. */
export function isBlockedSourceUrl(url: string): boolean {
  return allowedHost(url, BLOCKED_HOSTS);
}

/**
 * 사이트별 검색 갈래. **순서가 우선순위다** — 같은 호텔이 두 곳에서 오면 앞의 것이 남는다.
 *
 * 상세 주소 꼴은 [search-url.ts](../search-url.ts) `DETAIL_FORMATS` 와 같은 것이다.
 * 클룩은 갈래를 따로 두지 않는다(허용은 한다) — 호텔 상세가 검색에 잘 안 걸린다.
 */
export const SITE_BRANCHES = [
  {
    // ⚠️ **트립닷컴 하나다.** 날짜·인원이 애드픽을 거쳐도 살아서 가는 곳이 여기뿐이다
    //    (ALLOWED_HOSTS 주석). 호텔스닷컴 갈래를 같이 돌리면 줄은 늘지만, 그 줄 하나
    //    때문에 카드 전체가 날짜를 말하지 못하게 된다.
    site: '트립닷컴(kr.trip.com)',
    host: 'trip.com',
    detail:
      'https://kr.trip.com/hotels/detail/?hotelId=12345 또는 https://kr.trip.com/hotels/osaka-hotel-detail-12345/',
  },
] as const;

/**
 * 한 갈래에 시킬 후보 수의 **상한**.
 *
 * ⚠️ **많이 시킬수록 좋은 게 아니다.** 갈래가 둘일 때는 갈래마다 15곳이었는데
 *    (`OPENAI_CANDIDATE_COUNT` 30 을 갈래 수로 나눈다), 트립닷컴 하나로 좁히면서
 *    **한 갈래가 30곳을 떠안았다.** 한 사이트에 상세 페이지가 그만큼 없는 도시
 *    (가고시마 같은 소도시)에서는 모델이 **개수를 채우려고 도시 목록 페이지를 긁어
 *    온다** — 그건 서버가 전부 버리므로(`isHotelDetailUrl`) 카드가 통째로 빈다.
 *    시즈오카가 31곳 전부 목록 페이지였던 사고와 같은 모양이다.
 *
 * ⚠️ **대신 2차의 "고르기" 가 사실상 사라진다.** 후보 10곳에서 `RESULT_MAX_ITEMS`(20)
 *    개를 고르라고 하면 전부 고르게 된다. 그래도 2차는 남겨둔다 — 거기서 출처 대조와
 *    이름 검증이 돌고, 그게 지어낸 호텔을 거르는 자리다.
 */
export const MAX_CANDIDATES_PER_BRANCH = 10;

/** 프롬프트에 그대로 박아 넣는 표기. 목록과 문구가 어긋나지 않게 여기서 만든다. */
export const ALLOWED_SITES_TEXT = '트립닷컴(trip.com)';

/** 호텔 예약 링크로 인정하는가. 호스트 규칙은 항공권과 공유한다. */
export function isAllowedSourceUrl(url: string): boolean {
  return allowedHost(url, ALLOWED_HOSTS);
}

/**
 * 예약 링크를 한국어 페이지로 돌린다 (호스트/쿼리만 손댄다).
 * 규칙은 [booking-url.ts](../../../common/booking-url.ts) 에 있다 — 항공권도 같은 규칙을 쓴다.
 */
export { chooseUrl, toKoreanUrl } from '../../../common/booking-url';

/**
 * 검색 한 번에 대한 계측. 공통 필드는 [TwoStageTrace](../../openai/two-stage.ts) 에 있다.
 *
 * **읽는 쪽은 `POST /api/v1/debug/search` 의 `trace` 다.** 한동안 읽는 코드가 없어
 * 죽어 있었는데, 그 사이 원인 규명이 서버 로그 없이는 불가능했다 — 모델이 웹 검색을
 * 건너뛴 사실(`searchCalls=0`)이 로그에만 있었다. 이제 응답에 실린다.
 */
export interface SearchTrace extends TwoStageTrace {
  /**
   * **2차가 고른 뒤 정규화가 버린 수**, 이유별로.
   *
   * ⚠️ 로그에만 있던 값이다. 그런데 「호텔이 하나도 안 나온다」를 짚을 때 가장 먼저
   *    봐야 하는 숫자가 이거다 — `picks` 는 있는데 `kept` 가 0 이면 전부 여기서
   *    버려진 것이고, **무엇 때문인지에 따라 고칠 데가 전혀 다르다.**
   *
   *      listing  상세가 아닌 주소 (도시 목록·검색 결과). 주소 꼴 판정이나 프롬프트
   *      host     허용 목록 밖 사이트. 모델이 시킨 사이트를 안 쓴 것이다
   *      empty    이름이나 주소가 비었다
   */
  dropped: { listing: number; host: number; empty: number };
  /** 404·410 이라 버린 예약 링크 수. 모델이 주소를 지어낸 정도를 보여준다. */
  deadLinks: number;
  /** 페이지 제목에 호텔 이름이 없어서 버린 수. 다른 호텔·목록 페이지를 가리킨 것이다. */
  nameMismatches: number;
  /** 페이지 제목으로 이름까지 확인한 수. 나머지는 페이지를 못 읽어(봇 차단) 확인 못 했다. */
  namesVerified: number;
  /** 살아 있지 않아서 버린 이미지 주소 수. */
  droppedThumbnails: number;
  /** 최종적으로 이미지가 붙은 호텔 수. */
  thumbnails: number;
  /** 어느 층에서 건졌는지 (og / ld / photo). 층별 성공률을 봐야 손볼 데가 보인다. */
  thumbnailSources: Record<string, number>;
}

export interface TracedSearch {
  hotels: Hotel[];
  trace: SearchTrace;
  /** 1차 호출의 원문. 모델이 뭘 긁어왔는지 눈으로 봐야 할 때가 있다. */
  candidates: string | null;
}

/**
 * 1차가 긁어온 후보 하나. **2차는 이 중에서 번호만 고른다.**
 *
 * 그래서 카드에 쓰는 값이 전부 여기 있어야 한다 — 카드 줄은
 * `평점 x.x · 지역` 이고([listDescription](../hotel.types.ts)), 사진은 예약
 * 페이지에서 긁는다. 예전 2차 스키마가 요구하던 주소·성급·썸네일은 1차에
 * 없던 값이라 **모델이 지어내거나 null 이었다.**
 *
 * ⚠️ **`price_from` 은 카드에 안 나가지만 계속 받는다.** 집계가 그 값을 보고
 *    (`recommendation_items.price`), 2차 호출이 가격대를 섞어 고르는 데도 쓴다.
 */
interface RawCandidate {
  name?: unknown;
  url?: unknown;
  price_from?: unknown;
  review_score?: unknown;
  review_count?: unknown;
  area?: unknown;
  note?: unknown;
}

const SEARCH_INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 호텔 리서치 어시스턴트다.',
  '반드시 web_search 툴로 실제 웹을 검색해서 답한다. 기억에 의존하지 않는다.',
  `예약 링크는 반드시 ${ALLOWED_SITES_TEXT} 여야 한다.`,
  '트립닷컴이 아닌 사이트(아고다·부킹닷컴·호텔스닷컴·클룩·마이리얼트립 등)의 링크는 '
    + '쓸 수 없으니 적지 마라. 그 호텔이 트립닷컴에 없으면 다른 호텔을 골라라.',
  // 사용자는 한국인이다. 영문 페이지가 뜨면 예약까지 못 간다.
  '**반드시 한국어 페이지 주소를 골라라.** 같은 호텔이라도 영문 페이지가 아니라 '
    + '한국어 페이지 URL 을 적는다 (www.trip.com 이 아니라 kr.trip.com).',
  '검색 결과에 나오지 않은 URL·가격·평점·리뷰 수는 절대 지어내지 않는다. 모르면 null 로 둔다.',
  // ⚠️ 서버가 이걸 **검사한다**(groundedCandidates). 검색 도구가 돌려준 출처에 없는
  //    주소는 버려지므로, 기억으로 적은 주소는 카드까지 못 간다.
  '**URL 은 이번 검색에서 실제로 열어 보거나 검색 결과로 받은 주소를 그대로 옮겨 적는다.** '
    + '기억으로 주소를 만들거나 비슷하게 고쳐 쓰지 마라. 상세 페이지를 못 찾은 호텔은 빼라.',
  '**개수를 채우려고 호텔을 지어내지 마라.** 찾은 만큼만 낸다.',
  // ⚠️ 이 문장이 없으면 모델은 검색에 잘 걸리는 **도시 목록 페이지**를 호텔마다 붙인다.
  //    사용자는 호텔을 눌렀는데 목록에 떨어진다. 서버도 거르지만(isHotelDetailUrl)
  //    걸러진 만큼 카드가 짧아지므로 처음부터 상세를 고르게 한다.
  '**URL 은 반드시 그 호텔 한 곳의 상세 예약 페이지여야 한다.** 도시 호텔 목록·검색 결과·'
    + '지역 페이지(예: kr.trip.com/hotels/da-nang-hotels-list-1356/)는 안 된다. '
    // ⚠️ **`?hotelId=` 꼴을 먼저 적는다.** 날짜·인원을 박을 수 있는 꼴이 이것이라
    //    (DETAIL_FORMATS), 경로 꼴로 오면 그 줄은 조건 없이 나가고 카드도 날짜를
    //    말하지 못한다. 둘 다 상세 페이지라 모델에게는 차이가 없어 보인다.
    + '되도록 kr.trip.com/hotels/detail/?hotelId=… 꼴로 적는다 '
    + '(kr.trip.com/hotels/osaka-hotel-detail-12345/ 도 상세 페이지이긴 하다).',
  // ⚠️ 이 문단을 지우지 마라. 없으면 모델이 "검색을 진행해도 될까요?" 라고 되묻고 끝난다.
  //    상대는 사람이 아니라 프로그램이라 그 질문에 답해줄 사람이 없다.
  '**절대 되묻지 마라.** 확인을 구하거나 진행 여부를 묻지 말고 즉시 검색해서 결과만 낸다.',
  '날짜가 주어지지 않았으면 특정 날짜를 묻지 말고 일반적인 요금대를 조사한다.',
  '인사말·서론·맺음말·계획 설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

/**
 * 1차 호출도 구조화 출력을 건다.
 *
 * 자유 텍스트로 두면 모델이 "이렇게 정리해 드리겠습니다. 진행할까요?" 같은 문장을
 * 내놓고 끝난다 — 실제로 그래서 후보가 0개가 된 적 있다. 스키마를 걸면 그럴 자리가 없다.
 */
export const CANDIDATE_SCHEMA = {
  type: 'json_schema' as const,
  name: 'hotel_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'url', 'price_from', 'review_score', 'review_count', 'area', 'note'],
          properties: {
            name: { type: 'string', description: '호텔명 (한국어, 영문 병기)' },
            url: {
              type: 'string',
              description:
                `검색 결과에 실제로 나온 **그 호텔 한 곳의 상세** 예약 페이지 URL. ` +
                `${ALLOWED_SITES_TEXT}. 도시 목록·검색 결과 페이지는 안 된다. ` +
                '반드시 한국어 페이지 (kr.trip.com). 되도록 /hotels/detail/?hotelId=… 꼴로',
            },
            price_from: { type: ['integer', 'null'], description: '1박 최저가(원). 확인된 값만' },
            review_score: { type: ['number', 'null'], description: '10점 만점. 그 페이지에 적힌 값만' },
            review_count: {
              type: ['integer', 'null'],
              description: '리뷰 수. 그 페이지에 적힌 값만, 모르면 null',
            },
            area: { type: ['string', 'null'], description: '위치 (역/번화가 기준)' },
            note: { type: ['string', 'null'], description: '특징 한 줄' },
          },
        },
      },
    },
  },
};

/**
 * 2차에 주는 지시. **무엇을 기준으로 고르는가만 적는다.**
 *
 * 출력 형식("번호만 낸다")은 [INDEX_RULES](../../openai/two-stage.ts) 가 들고 있다 —
 * 스키마와 한 몸이라 도메인이 따로 말하면 어긋난다.
 */
const RANK_INSTRUCTIONS = [
  '너는 호텔 후보를 비교해 추천 목록을 만드는 어시스턴트다.',
  '가격·위치·평점·특징을 비교해 고른다.',
  '비슷한 호텔만 고르지 말고 가격대와 지역을 섞어라.',
  '**요청한 개수를 반드시 채워라.** 후보가 그만큼 없으면 있는 것을 전부 낸다 — 임의로 줄이지 마라.',
].join(' ');

@Injectable()
export class OpenAiHotelProvider
  extends TwoStageSearch<HotelQuery>
  implements HotelProvider
{
  readonly name = 'openai';
  protected readonly logger = new Logger(OpenAiHotelProvider.name);
  protected readonly label = 'hotel';

  protected readonly searchInstructions = SEARCH_INSTRUCTIONS;
  protected readonly candidateSchema = CANDIDATE_SCHEMA;
  protected readonly rankInstructions = RANK_INSTRUCTIONS;

  constructor(@Inject(CONFIG) config: AppConfig, openai: OpenAiService) {
    super(config, openai);
  }

  protected subjectOf(query: HotelQuery): string {
    return `city=${query.cityName}`;
  }

  protected limitOf(query: HotelQuery): number {
    return query.limit;
  }

  protected searchInput(query: HotelQuery, wanted: number): string {
    const guests = query.guests ? `${query.guests}명이 묵을 예정이다. ` : '';
    return [
      `${query.cityName} 에서 묵을 만한 호텔 ${wanted}곳을 지금 웹에서 검색해 찾아라.`,
      guests,
      '가격대와 지역이 겹치지 않게 다양하게 모아라.',
      '확인 못 한 항목은 null 로 둔다. 되묻지 말고 바로 결과를 낸다.',
    ].join('\n');
  }

  /**
   * **사이트별로 따로, 동시에 찾는다.**
   *
   * 한 번에 「오사카 호텔 30곳」을 시키면 모델은 「오사카 호텔」로 검색하고, 그 검색어에는
   * 예약 사이트의 **도시 목록 페이지**가 상위에 걸린다. 모델은 그 목록에서 이름만 따고
   * 주소는 목록 페이지를 붙인다 — 시즈오카는 31곳이 전부 그랬다(2026-11-09).
   *
   * 사이트를 하나로 좁히고 그 사이트의 상세 주소 꼴을 알려주면, 모델이 `site:` 검색으로
   * 호텔 하나짜리 페이지를 찾는다. 셋을 동시에 돌리므로 걸리는 시간은 한 번과 비슷하다.
   */
  protected override searchInputs(query: HotelQuery, wanted: number): string[] {
    const per = Math.min(
      MAX_CANDIDATES_PER_BRANCH,
      Math.max(5, Math.ceil(wanted / SITE_BRANCHES.length)),
    );
    const guests = query.guests ? `${query.guests}명이 묵을 예정이다.` : '';
    return SITE_BRANCHES.map((branch) =>
      [
        `${query.cityName} 에서 묵을 만한 호텔을 **${branch.site}** 에서만 찾아라. 최대 ${per}곳.`,
        guests,
        `검색어에 site:${branch.host} 를 붙여 그 사이트의 **호텔 상세 페이지**를 찾는다.`,
        `상세 페이지 주소는 이런 꼴이다: ${branch.detail}`,
        '도시 호텔 목록·검색 결과·지역 페이지 주소는 쓰지 마라. 상세 페이지를 못 찾은 호텔은 빼라.',
        '가격대와 지역이 겹치지 않게 다양하게 모아라. 확인 못 한 항목은 null 로 둔다.',
        '되묻지 말고 바로 결과를 낸다.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /** 검색 도구가 실제로 돌려준 주소만 쓴다 — 기억으로 적은 주소를 막는다. */
  protected override readonly groundsOnSources = true;

  /**
   * **검색 도구가 돌려준 출처와 주소가 맞는 후보만 남긴다.**
   *
   * 모델이 적은 주소는 타이핑한 값이다. 출처 목록은 검색 도구가 준 값이다. 둘이 맞아야
   * "실제 검색 결과에서 확인된 호텔" 이다. 표기 차이(`www.`/`kr.`, `/ko/`, 끝 슬래시)는
   * [verify.ts](../verify.ts) `urlKey` 가 지운다.
   */
  protected override groundedCandidates(candidates: unknown[], sources: string[]): unknown[] {
    const keys = sourceKeys(sources);
    return candidates.filter((c) => {
      const url = text((c as RawCandidate)?.url);
      const ok = Boolean(url) && isGrounded(url as string, keys);
      if (!ok) {
        this.logger.warn(
          `dropped hotel not in search sources name=${text((c as RawCandidate)?.name) ?? '-'} url=${url ?? '-'}`,
        );
      }
      return ok;
    });
  }

  protected rankInput(query: HotelQuery, candidates: string): string {
    const guests = query.guests ? `투숙 인원은 ${query.guests}명이다.` : '';
    return [
      `다음은 ${query.cityName} 호텔 후보 목록이다. 줄 맨 앞이 번호다.`,
      guests,
      `가장 추천할 만한 ${query.limit}곳의 번호를 골라라.`,
      `예약 페이지 URL 이 ${ALLOWED_SITES_TEXT} 밖인 후보는 고르지 마라.`,
      '',
      '--- 후보 목록 ---',
      candidates,
    ].join('\n');
  }

  /**
   * **허용 호스트 밖 후보를 2차에 넘기지 않는다.**
   *
   * 프롬프트가 1차·2차 양쪽에 "예약 링크는 네 곳 중 하나" 라고 적혀 있는데도 1차는
   * 아고다·부킹닷컴을 섞어 온다. 그 풀을 그대로 2차에 넘기면 모델이 **버려질 후보
   * 중에서** 20곳을 고르고, 정규화가 그중 대부분을 버린다 — 오사카에서 실제로
   * `picks=20 kept=2` 가 나왔고 사용자는 두 줄짜리 카드를 받았다.
   *
   * ⚠️ **toHotels 의 검사를 대신하지 않는다.** 2차가 범위 밖 번호를 줄 수 있고,
   *    링크를 지어낼 여지도 남아 있다. 여기는 **2차가 쓸모없는 선택을 하지 않게**
   *    하는 자리다.
   */
  protected override usableCandidates(candidates: unknown[]): unknown[] {
    // ⚠️ **사이트별로 따로 찾으므로 같은 호텔이 두 번 올 수 있다**(트립닷컴·호텔스닷컴).
    //    먼저 온 것을 남긴다 — 갈래 순서가 곧 사이트 우선순위다(SITE_BRANCHES).
    const seen = new Set<string>();
    return candidates.filter((c) => {
      const url = text((c as RawCandidate)?.url);
      // 목록 페이지 후보도 여기서 뺀다 — 넘기면 2차가 버려질 줄을 고른다(위와 같은 이유).
      if (!url || !isAllowedSourceUrl(url) || !isHotelDetailUrl(url)) return false;
      const key = nameKey(text((c as RawCandidate)?.name) ?? '');
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
  }

  async search(query: HotelQuery): Promise<Hotel[]> {
    return (await this.searchTraced(query)).hotels;
  }

  /** search() 와 같은 흐름이되 단계별 소요 시간을 같이 돌려준다. */
  async searchTraced(query: HotelQuery): Promise<TracedSearch> {
    const trace: SearchTrace = {
      ...newTwoStageTrace(),
      dropped: { listing: 0, host: 0, empty: 0 },
      deadLinks: 0,
      nameMismatches: 0,
      namesVerified: 0,
      droppedThumbnails: 0,
      thumbnails: 0,
      thumbnailSources: {},
    };
    const done = (hotels: Hotel[], candidates: string | null): TracedSearch => ({
      hotels,
      trace,
      candidates,
    });

    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 호텔 검색을 건너뛴다');
      return done([], null);
    }

    const candidates = await this.findCandidates(query, trace);
    if (!candidates) return done([], null);

    const picks = await this.rank<RawCandidate>(query, candidates, trace);
    const normalized = this.toHotels(picks, query, trace);
    const alive = await this.dropDeadLinks(normalized, trace, query);

    return done(
      await this.withThumbnails(alive, trace, query),
      JSON.stringify(candidates),
    );
  }

  // ------------------------------------------------------------ 정규화
  private toHotels(picks: RawCandidate[], query: HotelQuery, trace?: SearchTrace): Hotel[] {
    const hotels: Hotel[] = [];
    /** 어느 호스트에서 몇 개가 떨어졌나. 한 줄 요약에 쓴다. */
    const droppedHosts: Record<string, number> = {};
    let droppedEmpty = 0;
    let droppedListing = 0;

    for (const pick of picks) {
      const name = text(pick.name);
      const sourceUrl = text(pick.url);
      if (!name || !sourceUrl) {
        // ⚠️ **조용히 버리면 안 된다.** 스키마상 필수인 값이라 빠질 리 없다고 생각했지만,
        //    effort 를 내리면 모델이 빈 문자열이나 "정보 없음" 을 채워 보낸다. 그러면
        //    picks=10 인데 결과는 0건이 되고, 로그에 아무 흔적이 없어 원인을 못 찾는다.
        droppedEmpty += 1;
        this.logger.warn(
          `dropped hotel with empty field name=${name ?? '-'} url=${sourceUrl ?? '-'}`,
        );
        continue;
      }

      // 링크가 없으면 카드 줄을 만들 수 없다. 지어낸 호스트도 여기서 걸린다.
      if (!isAllowedSourceUrl(sourceUrl)) {
        count(droppedHosts, hostOf(sourceUrl));
        this.logger.warn(`dropped hotel with untrusted url name=${name} url=${sourceUrl}`);
        continue;
      }

      // 도시 목록 페이지. 누르면 호텔이 아니라 검색창이 열린다(isHotelDetailUrl).
      if (!isHotelDetailUrl(sourceUrl)) {
        droppedListing += 1;
        this.logger.warn(`dropped hotel with listing url name=${name} url=${sourceUrl}`);
        continue;
      }

      hotels.push({
        name,
        citySlug: query.citySlug,
        // 한국어 페이지로 돌린다. 프롬프트가 안 먹었을 때의 마지막 방어선.
        sourceUrl: toKoreanUrl(sourceUrl),
        merchant: merchantOf(sourceUrl),
        source: 'ai',
        sourceRef: null,
        // ⚠️ **주소·성급은 채우지 않는다.** 1차 후보 스키마에 없고 카드도 안 쓴다.
        //    예전 2차 스키마는 이걸 요구했고, 웹을 본 적 없는 모델이 지어냈다.
        address: null,
        starRating: null,
        reviewScore: bounded(pick.review_score, 0, 10),
        // 평점이 없으면 리뷰 수만 적어 봐야 뜻이 없다. 둘은 같은 페이지에서 같이 온다.
        reviewCount: positiveInt(pick.review_count),
        priceFrom: positiveInt(pick.price_from),
        currency: 'KRW',
        // 모델은 이미지 주소를 사실상 못 준다 — 아래 withThumbnails 가 예약 페이지에서
        // 직접 긁는다. 여기서 null 로 두는 게 "안 받았다" 는 사실에 맞다.
        thumbnailUrl: null,
        // ⚠️ **웹 검색 인용을 지운다.** web_search 를 켜면 모델이 출처를 본문에 박는다
        //    ("난바역 직결. ([kr.trip.com](https://…utm_source=openai))"). 카드 설명은
        //    40자라 대부분 잘리는데, 잘린 자리에 `([kr.trip` 같은 조각이 남는다.
        description: textWithoutCitations(pick.note),
        // 카드 줄의 마지막 조각이 tags[0] 이다. 1차가 준 지역을 그대로 쓴다.
        tags: [textWithoutCitations(pick.area)].filter((t): t is string => Boolean(t)),
      });
    }

    // ⚠️ **왜 한 줄로 또 남기나.** 위의 warn 들은 버려진 항목마다 한 줄씩이라, 스무
    //    곳이 떨어지면 스무 줄을 세어봐야 "몇 개가 왜 없어졌는지" 를 알 수 있다.
    //    `picks=20 kept=1` 은 그 자체로 답이고, hosts= 가 어느 사이트를 허용 목록에
    //    넣어야 하는지까지 알려준다 — 운영에서 실제로 여기서 열아홉 개가 떨어졌다.
    const droppedHost = picks.length - hotels.length - droppedEmpty - droppedListing;
    // ⚠️ **로그에만 두지 않는다.** 「호텔이 하나도 안 나온다」를 짚을 때 가장 먼저 봐야
    //    하는 숫자인데, 로그를 못 보는 자리에서는 응답만 보고 아무것도 알 수 없었다
    //    — `/debug/search` 의 trace 가 있는 이유가 그것이다.
    if (trace) trace.dropped = { listing: droppedListing, host: droppedHost, empty: droppedEmpty };

    if (picks.length !== hotels.length) {
      const hosts = Object.entries(droppedHosts)
        .map(([host, n]) => `${host}:${n}`)
        .join(' ');
      this.logger.warn(
        `hotel normalize ${this.subjectOf(query)} picks=${picks.length} kept=${hotels.length} ` +
          `droppedEmpty=${droppedEmpty} droppedListing=${droppedListing} ` +
          `droppedHost=${droppedHost}` +
          (hosts ? ` hosts=${hosts}` : ''),
      );
    }

    return hotels.slice(0, query.limit);
  }

  /**
   * **열리지 않는 예약 링크를 버린다.**
   *
   * 호스트만 보던 때는 `kr.hotels.com/아무거나` 가 그대로 통과했다. 모델은 실재하지
   * 않는 경로를 그럴듯하게 만들어내고, 그게 애드픽 변환을 타고 사용자에게 나간다 —
   * 눌러보면 다른 지역이 뜨거나 결과가 없거나 홈으로 튕겼다. 사용자는 그걸
   * **우리가 추천한 호텔**이라고 믿고 눌렀다.
   *
   * ⚠️ **404·410 만 죽은 것으로 본다.** 이 사이트들은 봇을 막아 403·429 를 자주
   *    주는데, 그건 "주소가 틀렸다" 가 아니라 "우리가 봇으로 보인다" 는 뜻이다.
   *    그걸 근거로 버리면 **멀쩡한 줄까지 전부 사라진다** — 영어 페이지가 뜨는 것을
   *    감수하면서까지 지켜온 판단이고([booking-url.ts](../../../common/booking-url.ts)
   *    `chooseUrl`), 여기서도 같다.
   *
   * ⚠️ **전부 버려져도 사용자는 빈손이 아니다.** 그때는 우리가 만든 지역 검색 링크가
   *    나간다([hotel.service.ts](../hotel.service.ts) `emptyRows`). 그 출구가 없으면
   *    이 검사는 "정리하지 못했어요" 를 늘리기만 한다.
   *
   * 백그라운드 검색에서만 도는 코드라 카카오 5초 예산과 무관하다.
   */
  private async dropDeadLinks(
    hotels: Hotel[],
    trace: SearchTrace,
    query: HotelQuery,
  ): Promise<Hotel[]> {
    if (!this.config.hotelVerifyLinks || !hotels.length) return hotels;

    const timeoutMs = this.config.hotelLinkCheckTimeoutMs;
    const checked = await Promise.all(
      hotels.map(async (hotel) => ({
        hotel,
        dead: await isDeadPage(hotel.sourceUrl, timeoutMs),
      })),
    );

    const alive = checked.filter((c) => !c.dead).map((c) => c.hotel);
    trace.deadLinks = hotels.length - alive.length;
    if (trace.deadLinks) {
      // ⚠️ **한 줄로 남긴다.** "호텔이 두 곳만 나온다" 를 만났을 때 모델이 적게 준
      //    건지 링크가 죽어 버려진 건지 갈라야 하는데, 이 줄이 그 답이다.
      const hosts = checked
        .filter((c) => c.dead)
        .map((c) => hostOf(c.hotel.sourceUrl))
        .join(' ');
      this.logger.warn(
        `hotel dead links ${this.subjectOf(query)} checked=${hotels.length} ` +
          `dropped=${trace.deadLinks} hosts=${hosts}`,
      );
    }
    return alive;
  }

  /**
   * 카드에 넣을 이미지를 확정한다.
   *
   * 모델이 준 주소가 있으면 살아 있는지 확인하고, 없거나 죽었으면
   * **예약 페이지에서 직접 긁는다**([thumbnail.ts](../thumbnail.ts)).
   *
   * ⚠️ 모델은 이미지 주소를 사실상 못 준다 — 1차 후보 스키마에 이미지 필드가 없고,
   *    `web_search` 도 텍스트만 주기 때문이다. 그래서 실질적인 경로는 페이지 긁기다.
   *
   * 콜백 경로에서만 도는 코드라 5초 예산과 무관하다. 결과는 검색 캐시에 같이
   * 저장되므로, 같은 도시를 다시 물어도 페이지를 또 읽지 않는다.
   */
  private async withThumbnails(
    hotels: Hotel[],
    trace: SearchTrace,
    query: HotelQuery,
  ): Promise<Hotel[]> {
    const illustrate = this.config.hotelThumbnails;
    if (!illustrate) {
      // 꺼져 있으면 카드에 사진이 하나도 안 나간다. 설정을 의심할 자리를 남긴다.
      this.logger.log(`hotel thumbnails off (HOTEL_THUMBNAILS=false) hotels=${hotels.length}`);
      // ⚠️ 이름 확인은 사진과 따로 켜고 끈다(HOTEL_VERIFY_LINKS). 둘 다 꺼야 페이지를 안 읽는다.
      if (!this.config.hotelVerifyLinks) return hotels;
    }

    /** 왜 못 붙였나. 개별 줄이 아니라 이걸로 진단한다 (아래 한 줄 요약). */
    const failed: Record<string, number> = {};

    const resolved = hotels.map(async (hotel): Promise<Hotel | null> => {
      // 페이지는 **한 번만** 읽는다. 이름 확인과 사진 긁기가 같은 HTML 을 쓴다.
      const html = await this.readPage(hotel.sourceUrl, failed);

      // ⓪ **그 호텔의 페이지인가.** 읽었는데 제목에 이름이 없으면 다른 호텔이거나
      //    목록 페이지다 — 사용자가 눌렀을 때 엉뚱한 곳이 열린다. 못 읽은 페이지(봇 차단)는
      //    판단할 근거가 없으므로 남긴다. 그 비율은 아래 요약의 unreadable 이 보여준다.
      const title = html && this.config.hotelVerifyLinks ? pageTitleOf(html) : null;
      if (title && !nameMatchesTitle(hotel.name, title, [query.cityName, query.citySlug])) {
        trace.nameMismatches += 1;
        this.logger.warn(
          `dropped hotel name mismatch name=${hotel.name} title=${JSON.stringify(title)} url=${hotel.sourceUrl}`,
        );
        return null;
      }
      if (title) trace.namesVerified += 1;
      if (!illustrate) return hotel;

      // ① 모델이 준 주소 (거의 없다)
      if (hotel.thumbnailUrl) {
        if (await isLiveImage(hotel.thumbnailUrl)) {
          trace.thumbnails += 1;
          count(trace.thumbnailSources, 'model');
          return hotel;
        }
        trace.droppedThumbnails += 1;
        this.logger.log(`dropped dead thumbnail hotel=${hotel.name} url=${hotel.thumbnailUrl}`);
      }

      // ② 예약 페이지에서 긁는다
      const found = html ? extractThumbnail(html, hotel.sourceUrl) : null;
      if (html && !found) count(failed, `noImage:${hostOf(hotel.sourceUrl)}`);
      if (!found) return { ...hotel, thumbnailUrl: null };

      if (!(await isLiveImage(found.url))) {
        trace.droppedThumbnails += 1;
        count(failed, 'notLive');
        this.logger.log(`page thumbnail not live hotel=${hotel.name} url=${found.url}`);
        return { ...hotel, thumbnailUrl: null };
      }

      trace.thumbnails += 1;
      count(trace.thumbnailSources, found.source);
      this.logger.log(`thumbnail ${found.source} hotel=${hotel.name} url=${found.url}`);
      return { ...hotel, thumbnailUrl: found.url };
    });

    const withImages = (await Promise.all(resolved)).filter((h): h is Hotel => h !== null);

    // ⚠️ **한 줄로 남긴다.** 개별 줄(page unreadable / not live)은 호텔마다 하나씩이라
    //    스무 곳이면 스무 줄을 세어봐야 "사진이 왜 없나" 를 알 수 있다. 실측으로는
    //    사이트가 원인을 가른다 — trip.com 은 photo 층에서 잘 나오고, hotels.com(429)과
    //    클룩(403)은 페이지를 아예 못 읽는다. hosts= 가 그걸 바로 보여준다.
    const filled = withImages.filter((hotel) => hotel.thumbnailUrl).length;
    if (filled < withImages.length) {
      this.logger.warn(
        `hotel thumbnails ${this.subjectOf(query)} hotels=${withImages.length} ` +
          `filled=${filled} ${describe(failed)} ` +
          `sources=${describe(trace.thumbnailSources) || '-'}`,
      );
    }
    return withImages;
  }

  /**
   * 예약 페이지 HTML 을 (앞부분만) 읽는다. 못 읽으면 null.
   *
   * ⚠️ **두 가지 실패를 갈라 센다.** "페이지를 못 읽었다"(차단·타임아웃)와 "읽었는데
   *    사진이 없다"(추출 실패)는 손볼 데가 전혀 다르다 — 앞은 사이트 문제라 할 수
   *    있는 게 별로 없고, 뒤는 추출기에 층을 하나 더 얹으면 된다.
   */
  private async readPage(pageUrl: string, failed: Record<string, number>): Promise<string | null> {
    if (!pageUrl) {
      count(failed, 'noUrl');
      return null;
    }
    const html = await fetchHtml(
      pageUrl,
      this.config.hotelThumbnailTimeoutMs,
      this.config.hotelThumbnailMaxBytes,
    );
    if (!html) {
      count(failed, `unreadable:${hostOf(pageUrl)}`);
      this.logger.log(`hotel page unreadable url=${pageUrl}`);
    }
    return html;
  }
}

/** Record 카운터 증가. 층별 성공률을 보려고 쓴다. */
function count(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/** 카운터를 로그 한 조각으로. 비어 있으면 빈 문자열이라 줄이 지저분해지지 않는다. */
function describe(bucket: Record<string, number>): string {
  return Object.entries(bucket)
    .map(([key, n]) => `${key}=${n}`)
    .join(' ');
}

/**
 * 로그에 찍을 호스트명.
 *
 * ⚠️ **https 가 아니면 스킴을 같이 찍는다.** `allowedHost` 는 호스트가 목록에 있어도
 *    http 면 떨어뜨리는데, 그때 호스트만 찍으면 `hosts=kr.trip.com:20` 이 되어
 *    "허용 목록에 있는데 왜 떨어지지" 로 읽힌다. 진단하려고 남기는 줄이 엉뚱한 곳을
 *    가리키면 없느니만 못하다.
 */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      ? parsed.hostname
      : `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return '(잘못된 주소)';
  }
}

/**
 * 예약 페이지를 브라우저인 척 읽는다.
 *
 * ⚠️ **UA 를 안 보내면 403·429 를 준다.** 실제로 hotels.com 이 그렇다.
 *    우리가 이미 사용자에게 링크로 보내주는 공개 페이지이고, 읽는 것은 앞부분 몇백 KB 뿐이다.
 *
 * 본문 전체를 받지 않는 이유: 예약 페이지는 200~400KB 인데 이미지 주소는 앞쪽에 있다.
 * 5곳을 동시에 읽으므로 다 받으면 메모리와 시간을 헛되이 쓴다.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchHtml(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'ko-KR,ko;q=0.9',
        },
      },
      timeoutMs,
      // ⚠️ 여기서 시계가 계속 돈다는 게 중요하다 — 본문을 찔끔찔끔 흘리는 페이지를
      //    만나도 timeoutMs 에서 끊긴다.
      async (res) => {
        if (!res.ok) return null;
        if (!(res.headers.get('content-type') ?? '').includes('text/html')) return null;

        const reader = res.body?.getReader();
        if (!reader) return null;

        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (size < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
          }
        } finally {
          // 다 안 읽고 끊는다. 취소하지 않으면 연결이 남는다.
          await reader.cancel().catch(() => undefined);
        }
        return Buffer.concat(chunks).toString('utf8');
      },
    );
  } catch {
    return null;
  }
}

export function merchantOf(url: string): string | null {
  return merchantFrom(url, ALLOWED_HOSTS);
}

/**
 * **이 주소가 확실히 죽었는가.** 모르면 false — 살아 있는 쪽이 안전한 기본값이다.
 *
 * ⚠️ **404·410 만 죽은 것으로 센다.** 403·429(봇 차단)·타임아웃·네트워크 오류는
 *    전부 "모르겠다" 다. 그걸 죽음으로 세면 사이트가 우리를 막는 날 **카드가 통째로
 *    비어버린다.**
 *
 * HEAD 를 먼저 쓰고, 막히면 1바이트만 받아 다시 본다 — 예약 페이지는 수백 KB 라
 * 본문을 받을 이유가 없다. 썸네일 검사(`isLiveImage`)와 같은 수법이다.
 */
async function isDeadPage(url: string, timeoutMs: number): Promise<boolean> {
  if (!url) return true;
  const gone = (res: Response | null): boolean | null => {
    if (!res) return null;
    if (res.status === 404 || res.status === 410) return true;
    // 200 이든 403 이든 "404 는 아니다" 가 우리가 아는 전부다.
    return false;
  };

  // ⚠️ **브라우저인 척해야 한다.** UA 를 안 보내면 이 사이트들은 봇으로 보고
  //    막는데, 그게 403 이면 다행이고 **404 를 주는 곳이면 멀쩡한 호텔이 통째로
  //    사라진다.** 같은 이유로 페이지 긁기(fetchHtml)도 UA 를 보낸다.
  const headers = { 'user-agent': BROWSER_UA, 'accept-language': 'ko-KR,ko;q=0.9' };

  const head = gone(await probe(url, 'HEAD', headers, timeoutMs));
  if (head !== null) return head;

  // HEAD 자체를 막는 CDN 이 있다. 1바이트만 받아서 다시 본다.
  return gone(await probe(url, 'GET', { ...headers, range: 'bytes=0-0' }, timeoutMs)) ?? false;
}

/**
 * 주소가 실제로 살아 있는 이미지인지 본다. 2초 안에 답 없으면 버린다.
 *
 * CDN 마다 사정이 다르다. 실측하면서 걸린 것들:
 *   - trip.com CDN 은 HEAD 에 **content-type 을 안 준다.** 없다고 버리면 다 놓친다.
 *   - HEAD 자체를 막는 CDN 이 있다. 그때는 1KB 만 받아서 다시 본다.
 */
async function isLiveImage(url: string): Promise<boolean> {
  const acceptable = (res: Response): boolean => {
    if (!res.ok) return false;
    const type = res.headers.get('content-type');
    // 타입을 안 알려주면 200 을 믿는다. 어차피 죽은 주소면 200 이 안 온다.
    return !type || type.startsWith('image/');
  };

  const head = await probe(url, 'HEAD');
  if (head) return acceptable(head);

  const ranged = await probe(url, 'GET', { range: 'bytes=0-1023' });
  return ranged ? acceptable(ranged) : false;
}

/** 죽은 주소 하나 때문에 카드 전체를 늦출 수는 없다. */
const PROBE_TIMEOUT_MS = 2000;

async function probe(
  url: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string> = {},
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(url, { method, headers }, timeoutMs, async (res) => {
      // 요청 자체는 성공했으므로 판정은 호출부에 맡긴다.
      await res.body?.cancel().catch(() => undefined);
      return res;
    });
  } catch {
    return null;
  }
}

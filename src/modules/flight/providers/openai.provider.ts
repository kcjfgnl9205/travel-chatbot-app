import { Inject, Injectable, Logger } from '@nestjs/common';

import { allowedHost, merchantFrom, toKoreanUrl } from '../../../common/booking-url';
import { positiveInt, text } from '../../../common/parse';
import { AppConfig, CONFIG } from '../../../config/app.config';
import { OpenAiService } from '../../openai/openai.service';
import { TwoStageSearch, TwoStageTrace, newTwoStageTrace } from '../../openai/two-stage';
import { Flight, FlightProvider, FlightQuery } from '../flight.types';

/**
 * gpt-5-mini + 웹 검색으로 항공권을 찾는 provider.
 *
 *   1차 호출 : 웹 검색을 돌려 후보 10~20편을 긁는다 (구조화 JSON)
 *   2차 호출 : 후보를 가격·소요시간·경유로 비교해 상위 N개를 JSON 으로 뽑는다
 *
 * 호텔 provider 와 같은 2단 구조다. 이유도 같다 — 한 번에 시키면 모델이 검색 결과를
 * 요약하는 데 힘을 쓰고 비교/선별은 대충 한다.
 *
 * ⚠️ **항공 운임은 실시간이고 우리는 실시간 API 가 없다.**
 *    웹 검색으로 얻는 건 "그 노선이 대략 얼마인가" 이지 지금 살 수 있는 가격이 아니다.
 *    그래서 카드에 '예상가' 로 적고, 실제 금액은 예약 페이지에서 확인하게 만든다.
 *    여기를 정확한 운임처럼 포장하면 사용자는 카드 가격을 믿고 눌렀다가 배신당한다.
 *    (GDS/항공사 API 가 붙으면 이 provider 를 갈아끼우면 된다 — 그래서 토큰으로 주입한다)
 *
 * ⚠️ 느리다(합쳐서 7~30초). 카카오 5초 예산 안에서 부르면 안 된다.
 *    FlightService 가 콜백/백그라운드에서만 호출한다.
 */

/**
 * 예약 링크로 인정하는 호스트.
 *
 * 클룩·호텔스닷컴은 호텔 쪽 목록에 있지만 여기엔 없다 — **항공권을 팔지 않아서**
 * 허용해두면 모델이 "항공권 링크" 라며 엉뚱한 페이지를 가져온다.
 *
 * ⚠️ **스카이스캐너는 애드픽에 광고주가 없다** (확인됨). 그래서 이 줄은 수익이
 *    나지 않고, 변환을 시도하지도 않는다 — 원본 주소로 그대로 보낸다
 *    ([ADPICK_UNSUPPORTED_MERCHANTS](../../adpick/adpick.service.ts)).
 *    그래도 넣어둔 이유는 **노선 검색 페이지가 색인이 잘 돼 있어서**다. 마이리얼트립
 *    항공은 웹 검색에 잘 안 잡혀 카드가 트립닷컴 한 줄로 끝나는 일이 잦았다.
 *    수익 안 나는 줄 하나보다 줄이 하나뿐인 카드가 나쁘다.
 *
 * ⚠️ 여기를 바꾸면 SEARCH_INSTRUCTIONS 와 스키마의 안내 문구도 같이 바꿔야 한다.
 *    모델에게 A 를 찾으라고 시켜놓고 B 만 통과시키면 결과가 전부 버려진다.
 */
export const FLIGHT_ALLOWED_HOSTS = [
  'trip.com', // 트립닷컴 항공
  'myrealtrip.com', // 마이리얼트립 항공
  // 스카이스캐너는 국가 도메인이 갈린다. 셋 다 merchantFrom 이 'skyscanner' 로 읽으므로
  // 어느 쪽으로 들어와도 줄은 하나로 접힌다(toKoreanUrl 이 .co.kr 로 돌려놓는다).
  'skyscanner.co.kr',
  'skyscanner.net',
  'skyscanner.com',
];

/** 프롬프트에 그대로 박아 넣는 표기. 목록과 문구가 어긋나지 않게 여기서 만든다. */
export const FLIGHT_ALLOWED_SITES_TEXT =
  '트립닷컴(trip.com), 마이리얼트립(myrealtrip.com), 스카이스캐너(skyscanner.co.kr)';

export function isAllowedFlightUrl(url: string): boolean {
  return allowedHost(url, FLIGHT_ALLOWED_HOSTS);
}

export function flightMerchantOf(url: string): string | null {
  return merchantFrom(url, FLIGHT_ALLOWED_HOSTS);
}

const SEARCH_INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 항공권 리서치 어시스턴트다.',
  '반드시 web_search 툴로 실제 웹을 검색해서 답한다. 기억에 의존하지 않는다.',
  `예약 링크는 반드시 다음 세 곳 중 하나여야 한다: ${FLIGHT_ALLOWED_SITES_TEXT}.`,
  '이 세 곳이 아닌 사이트(네이버항공권·인터파크·항공사 자체 사이트 등)의 링크는 적지 마라.',
  '**반드시 한국어 페이지 주소를 골라라** (www.trip.com 이 아니라 kr.trip.com, ' +
    'www.skyscanner.net 이 아니라 www.skyscanner.co.kr).',
  '검색 결과에 나오지 않은 편명·시각·가격은 절대 지어내지 않는다. 모르면 null 로 둔다.',
  '항공사는 한국어로 적는다 (Korean Air → 대한항공, Peach → 피치항공).',
  '가격은 1인 기준 총액(세금·유류할증료 포함)을 원화로 적는다.',
  // ⚠️ 이 문단을 지우지 마라. 없으면 모델이 "검색을 진행해도 될까요?" 라고 되묻고 끝난다.
  //    상대는 사람이 아니라 프로그램이라 그 질문에 답해줄 사람이 없다.
  '**절대 되묻지 마라.** 확인을 구하거나 진행 여부를 묻지 말고 즉시 검색해서 결과만 낸다.',
  '날짜가 주어지지 않았으면 특정 날짜를 묻지 말고 최근 기준 일반적인 요금대를 조사한다.',
  '인사말·서론·맺음말·계획 설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

/**
 * 1차 호출도 구조화 출력을 건다.
 *
 * 자유 텍스트로 두면 모델이 "이렇게 정리해 드리겠습니다. 진행할까요?" 같은 문장을
 * 내놓고 끝난다 — 호텔 쪽에서 실제로 그래서 후보가 0개가 된 적 있다.
 */
export const FLIGHT_CANDIDATE_SCHEMA = {
  type: 'json_schema' as const,
  name: 'flight_candidates',
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
          required: [
            'airline',
            'flight_no',
            'url',
            'price_from',
            'stops',
            'duration_minutes',
            'note',
          ],
          properties: {
            airline: { type: 'string', description: '항공사 (한국어)' },
            flight_no: { type: ['string', 'null'], description: 'KE723 형식. 모르면 null' },
            url: {
              type: 'string',
              description:
                `검색 결과에 실제로 나온 예약 페이지 URL. ${FLIGHT_ALLOWED_SITES_TEXT} 중 하나. ` +
                '반드시 한국어 페이지 (kr.trip.com, www.skyscanner.co.kr 등)',
            },
            price_from: {
              type: ['integer', 'null'],
              description: '1인 총액(원). 확인된 값만',
            },
            stops: { type: ['integer', 'null'], description: '경유 횟수. 직항은 0' },
            // ⚠️ 2차가 아니라 **여기서** 받아야 한다. 웹을 실제로 본 건 1차뿐이고,
            //    2차에 물으면 후보에 없는 값을 지어낸다 (카드의 '직항 1시간 55분').
            duration_minutes: {
              type: ['integer', 'null'],
              description: '편도 총 소요 시간(분). 확인된 값만',
            },
            note: { type: ['string', 'null'], description: '시각·특징 한 줄' },
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
  '너는 항공권 후보를 비교해 추천 목록을 만드는 어시스턴트다.',
  '가격만 보지 말고 직항 여부와 소요 시간을 섞어서 고른다.',
  '같은 플랫폼만 고르지 마라 — 어디가 싼지는 플랫폼이 섞여야 드러난다.',
  '**요청한 개수를 반드시 채워라.** 후보가 그만큼 없으면 있는 것을 전부 낸다 — 임의로 줄이지 마라.',
].join(' ');

/**
 * 검색 한 번에 대한 계측. 공통 필드는 [TwoStageTrace](../../openai/two-stage.ts) 에 있다.
 *
 * ⚠️ **지금 이 값을 읽는 코드가 없다.** 주석이 가리키던 /api/v1/debug/flight-search 는
 *    컨트롤러가 /debug/search 하나로 합쳐지면서 사라졌고, 로그에 찍히는 건 trace 가
 *    아니라 respond() 의 반환값이다. 남겨둔 이유와 정리 방향은 TwoStageTrace 주석 참고.
 */
export type FlightSearchTrace = TwoStageTrace;

export interface TracedFlightSearch {
  flights: Flight[];
  trace: FlightSearchTrace;
  /** 1차 호출의 원문. 모델이 뭘 긁어왔는지 눈으로 봐야 할 때가 있다. */
  candidates: string | null;
}

/**
 * 1차가 긁어온 후보 하나. **2차는 이 중에서 번호만 고른다.**
 *
 * 그래서 카드에 쓰는 값이 전부 여기 있어야 한다 — 예전에는 2차 스키마가 시각·경유지·
 * 좌석등급까지 요구했는데, 웹을 본 적 없는 2차가 그걸 지어내고 있었다.
 */
interface RawCandidate {
  airline?: unknown;
  flight_no?: unknown;
  url?: unknown;
  price_from?: unknown;
  stops?: unknown;
  duration_minutes?: unknown;
  note?: unknown;
}

@Injectable()
export class OpenAiFlightProvider
  extends TwoStageSearch<FlightQuery>
  implements FlightProvider
{
  readonly name = 'openai';
  protected readonly logger = new Logger(OpenAiFlightProvider.name);
  protected readonly label = 'flight';

  protected readonly searchInstructions = SEARCH_INSTRUCTIONS;
  protected readonly candidateSchema = FLIGHT_CANDIDATE_SCHEMA;
  protected readonly rankInstructions = RANK_INSTRUCTIONS;

  constructor(@Inject(CONFIG) config: AppConfig, openai: OpenAiService) {
    super(config, openai);
  }

  protected subjectOf(query: FlightQuery): string {
    return `route=${routeText(query)}`;
  }

  protected limitOf(query: FlightQuery): number {
    return query.limit;
  }

  protected searchInput(query: FlightQuery, wanted: number): string {
    return [
      `${routeText(query)} 항공권 ${wanted}편을 지금 웹에서 검색해 찾아라.`,
      conditionsText(query),
      '항공사와 가격대가 겹치지 않게 다양하게 모아라. 직항과 경유를 섞어라.',
      '확인 못 한 항목은 null 로 둔다. 되묻지 말고 바로 결과를 낸다.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  protected rankInput(query: FlightQuery, candidates: string): string {
    return [
      `다음은 ${routeText(query)} 항공권 후보 목록이다. 줄 맨 앞이 번호다.`,
      conditionsText(query),
      `가격·소요시간·경유를 비교해 가장 추천할 만한 ${query.limit}편의 번호를 골라라.`,
      `예약 페이지 URL 이 ${FLIGHT_ALLOWED_SITES_TEXT} 밖인 후보는 고르지 마라.`,
      '',
      '--- 후보 목록 ---',
      candidates,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async search(query: FlightQuery): Promise<Flight[]> {
    return (await this.searchTraced(query)).flights;
  }

  /** search() 와 같은 흐름이되 단계별 소요 시간을 같이 돌려준다. */
  async searchTraced(query: FlightQuery): Promise<TracedFlightSearch> {
    const trace: FlightSearchTrace = newTwoStageTrace();
    const done = (flights: Flight[], candidates: string | null): TracedFlightSearch => ({
      flights,
      trace,
      candidates,
    });

    if (!this.openai.enabled) {
      this.logger.warn('OPENAI_API_KEY 가 없어 항공권 검색을 건너뛴다');
      return done([], null);
    }

    const candidates = await this.findCandidates(query, trace);
    if (!candidates) return done([], null);

    const picks = await this.rank<RawCandidate>(query, candidates, trace);
    return done(this.toFlights(picks, query), JSON.stringify(candidates));
  }

  // ------------------------------------------------------------ 정규화
  /**
   * 고른 후보를 Flight 로 만든다.
   *
   * ⚠️ **시각·경유지·좌석등급은 채우지 않는다.** 1차 후보 스키마에 없는 값이고,
   *    카드도 안 쓴다(시세 · 직항+소요시간 · 항공사). 예전에는 2차 스키마가 이걸
   *    요구해서 모델이 지어냈다 — 필요해지면 **1차 후보 스키마에** 더해야지,
   *    웹을 본 적 없는 2차에 물어서는 안 된다.
   */
  private toFlights(picks: RawCandidate[], query: FlightQuery): Flight[] {
    const flights: Flight[] = [];

    for (const pick of picks) {
      const airline = text(pick.airline);
      const sourceUrl = text(pick.url);
      if (!airline || !sourceUrl) continue;

      // 링크가 없으면 카드를 만들 수 없다. 지어낸 호스트도 여기서 걸린다.
      if (!isAllowedFlightUrl(sourceUrl)) {
        this.logger.warn(`dropped flight with untrusted url airline=${airline} url=${sourceUrl}`);
        continue;
      }

      flights.push({
        airline,
        flightNo: flightNumber(pick.flight_no),
        // 공항 코드는 쿼리가 정본이다 — 검색 자체가 그 노선으로 나갔다.
        originCode: query.originCode ?? query.originSlug.toUpperCase(),
        originName: query.originName,
        destCode: query.destCode ?? query.destSlug.toUpperCase(),
        destName: query.destName,
        departDate: null,
        departTime: null,
        arriveTime: null,
        returnDate: null,
        returnDepartTime: null,
        returnArriveTime: null,
        durationMinutes: positiveInt(pick.duration_minutes),
        stops: stops(pick.stops),
        via: null,
        tripType: query.tripType,
        cabin: null,
        priceFrom: positiveInt(pick.price_from),
        currency: 'KRW',
        // 한국어 페이지로 돌린다. 프롬프트가 안 먹었을 때의 마지막 방어선.
        sourceUrl: toKoreanUrl(sourceUrl),
        merchant: flightMerchantOf(sourceUrl),
        source: 'ai',
        tags: [],
      });
    }

    return flights.slice(0, query.limit);
  }
}

// ------------------------------------------------------------------ 프롬프트 조각
/** '인천(ICN) → 오사카(KIX)'. 프롬프트와 로그에서 같은 표기를 쓴다. */
export function routeText(query: FlightQuery): string {
  const from = query.originCode ? `${query.originName}(${query.originCode})` : query.originName;
  const to = query.destCode ? `${query.destName}(${query.destCode})` : query.destName;
  return `${from} → ${to}`;
}

/**
 * 검색 조건을 문장으로.
 *
 * ⚠️ **날짜가 없다.** 캐시를 노선·왕복여부로만 가르기로 했기 때문이다
 *    ([search.service.ts](../../search/search.service.ts) cacheKeyOf). 날짜를 안 주면
 *    모델은 되묻거나 임의의 날짜를 지어내므로, **"일반적인 요금대를 조사하라"** 고
 *    명시적으로 못 박는다. 카드에는 "AI 가 정리한 참고 정보" 안내가 항상 붙는다.
 */
export function conditionsText(query: FlightQuery): string {
  return [
    query.tripType === 'round' ? '왕복이다.' : '편도다.',
    '특정 날짜가 정해지지 않았으니 최근 한 달 기준의 일반적인 요금대를 조사한다.',
    '날짜를 지어내지 말고, 확인된 날짜가 없으면 날짜 필드는 null 로 둔다.',
  ].join(' ');
}

// ------------------------------------------------------------------ 헬퍼
/** 'ke 723' → 'KE723'. 편명은 dedupe 키라 표기를 통일해야 한다. */
function flightNumber(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /([A-Za-z]{2})\s*-?\s*(\d{1,4})/.exec(raw);
  return match ? `${match[1].toUpperCase()}${match[2]}` : raw.toUpperCase();
}

/** 경유 횟수. 0 은 유효한 값이므로 positiveInt 로 걸러선 안 된다. */
function stops(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n;
}

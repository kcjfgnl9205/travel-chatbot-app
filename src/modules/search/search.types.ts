import { ResolvedLink } from '../affiliate/affiliate.service';
import * as t from '../kakao/templates';
import { Place } from '../places/places.types';

/** 우리가 처리하는 세 가지. 그 외는 도움말 카드로 간다. */
export type SearchKind = 'hotel' | 'flight' | 'attraction';

/** 왕복(rt) / 편도(ow). 항공권에만 있다. */
export type TripType = 'rt' | 'ow';

/**
 * 한 번의 검색이 무엇을 찾는지.
 *
 * ⚠️ **날짜·인원이 없다.** 캐시를 지역(+노선)으로만 가르기로 했기 때문이다.
 *    사용자가 말한 조건은 `ignored` 로 옮겨 카드 아래 안내에 적는다 —
 *    고지 없이 날짜를 무시한 결과를 주면 사용자는 속았다고 느낀다.
 */
export interface SearchContext {
  kind: SearchKind;
  /** 호텔·관광지의 대상 지역. 항공권은 도착지. */
  place: Place;
  /** 세부 지역의 부모 도시 (도톤보리 → 오사카). 없으면 null. */
  parent: Place | null;
  /** 항공권 출발지. 그 외 도메인은 null. */
  from: Place | null;
  tripType: TripType;
  /** 저장할 최대 건수. */
  limit: number;
}

/**
 * 행에 같이 저장해두는 표시용 정보.
 *
 * **"더 보기" 요청은 cache_key 와 offset 만 들고 온다.** 발화에 지역이 없으므로
 * (버튼이 보낸 문장은 "오사카 호텔 더 보기" 지만 믿을 수 없다) 카드 머리글과 다음
 * 버튼을 만들려면 지역명이 행에 남아 있어야 한다. 없으면 페이지를 넘길 때마다
 * 지역을 다시 해석해야 하고, 그건 AI 호출 0회라는 더보기의 전제를 깬다.
 */
export interface SearchMeta {
  kind: SearchKind;
  placeName: string;
  placeSlug: string;
  fromName?: string | null;
  tripType?: TripType | null;
  /** 출발지를 사용자가 말하지 않아 서울로 채웠는가. 안내 문구가 갈린다. */
  originAssumed?: boolean;
  /**
   * 연속으로 빈손이었던 횟수.
   *
   * ⚠️ **한 번의 빈 결과로 굳히지 않기 위해 센다.** 모델은 같은 질의에도 가끔
   *    빈손으로 돌아온다 — 한 번에 10분을 굳히면 그게 10분짜리 장애가 된다.
   *    ("도쿄 호텔" 이 실제로 그랬다. 도쿄에 호텔이 없을 리 없다)
   */
  emptyStreak?: number;
}

export interface SearchRow {
  cacheKey: string;
  kind: SearchKind;
  status: 'pending' | 'ready' | 'failed';
  items: unknown[];
  meta: SearchMeta;
  error: string | null;
  fetchedAt: number | null;
  expiresAt: number | null;
  /**
   * 낙관적 잠금용 도장.
   *
   * 만료된 행을 다시 검색하려면 pending 으로 되돌려야 하는데, 그 update 에
   * "내가 본 그 상태 그대로일 때만" 조건을 걸어야 두 요청이 같이 검색하지 않는다.
   */
  updatedAt: string | null;
}

/** 카드 한 장을 만들 때 도메인에 넘기는 맥락. */
export interface RenderContext {
  meta: SearchMeta;
  userId: string | null;
  messageId: string | null;
  started: number;
  cacheHit: boolean;
  /** 통계를 남길지. 진단 경로만 false 다 — 섞이면 전환율 집계가 틀어진다. */
  persist?: boolean;
  /**
   * 미리 해석해둔 제휴 링크. 주면 애드픽을 다시 부르지 않는다.
   *
   * 빈 Map 은 "변환하지 않는다" 는 뜻이고, 그때 목적지는 원본 주소가 된다.
   * 어느 쪽이든 **카드 JSON 은 같다** — 줄 링크는 `/r/{clickId}` 이고 애드픽 주소는
   * 그 302 목적지로만 쓰인다. (진단 엔드포인트가 쓴다)
   */
  links?: Map<string, ResolvedLink>;
}

/**
 * 도메인 하나(호텔·항공권·관광지)가 라우터에게 제공해야 하는 것.
 *
 * 라우터·캐시·페이지네이션은 **도메인을 모른다.** 무엇을 검색하고 어떻게 한 줄로
 * 그리는지만 도메인이 안다. 네 번째 도메인이 생겨도 search.service.ts 는 그대로다.
 */
export interface SearchDomain<T = unknown> {
  readonly kind: SearchKind;
  /**
   * 지금 검색할 수 있는 상태인가 (provider 에 키가 있는가).
   *
   * false 면 라우터는 **대기 응답을 만들지 않는다.** 못 지킬 약속을 하는 대신
   * 지금은 안 된다고 말한다 — 30초를 기다린 사용자가 또 물어보고 또 기다리는
   * 게 가장 나쁘다.
   */
  readonly ready: boolean;
  /** ⚠️ 느리다(AI 검색 7~30초). 라우터는 이걸 백그라운드에서만 부른다. */
  search(ctx: SearchContext): Promise<T[]>;
  /** 캐시에서 살려낸 값이 이 도메인의 모양인가. 배포로 필드가 바뀌면 미스로 떨어진다. */
  isItem(item: unknown): item is T;
  /** 카드 머리글. '오사카 호텔 5곳' / '서울→오사카 항공권 5편' */
  headerTitle(meta: SearchMeta, count: number, start: number): string;
  /** 한 페이지를 listCard 줄로. 노출 기록·클릭 링크 발급이 여기서 일어난다. */
  rows(items: T[], ctx: RenderContext): Promise<t.Json[]>;
  /** "더 보기" 버튼이 보낼 문장. '오사카 호텔 더 보기' */
  moreText(meta: SearchMeta): string;
  /** 카드에 붙일 퀵리플라이. */
  quickReplies(meta: SearchMeta): t.Json[];
}

/**
 * 라우터가 한 번의 요청에 대해 알고 있는 것.
 *
 * 컨트롤러가 채우고 SearchService 가 받는다. payload 를 통째로 넘기지 않는 이유는,
 * 검색 쪽이 카카오 페이로드 구조를 직접 파고들기 시작하면 그 구조가 바뀔 때마다
 * 도메인 코드까지 같이 흔들리기 때문이다.
 */
export interface RouterRequest {
  utterance: string;
  userKey: string;
  userId: string | null;
  /**
   * 콜백 주소. **오픈빌더에서 콜백을 켠 경우에만 실린다.**
   * 없으면 "잠시 뒤 다시 물어봐 주세요" 경로로 간다.
   */
  callbackUrl: string | null;
  /**
   * "더 보기" 버튼이 부를 블록. 라우터는 폴백 블록이 부르므로 요청이 알려준
   * block.id 가 곧 정답이다 (설정으로 덮어쓸 수 있다).
   */
  blockId: string;
  /** 요청 시작 시각. 5초 예산 대비 여유를 재는 데 쓴다. */
  started: number;
  /**
   * 봇 이름 ("여행메이트 TST").
   *
   * 단톡방에서는 **봇을 멘션한 메시지만** 서버로 온다. 사용자에게 직접 입력을
   * 부탁할 때 이 이름이 없으면 "그냥 치세요" 가 되고, 멘션을 빠뜨린 발화는
   * 봇이 아예 듣지 못한다 — 사용자에게는 봇이 죽은 것처럼 보인다.
   */
  botName: string | null;
}

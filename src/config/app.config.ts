/**
 * 환경변수.
 *
 * 파이썬판(app/core/config.py)과 **변수 이름을 그대로 맞췄다.**
 * 같은 .env 파일로 양쪽 다 돌아가야 전환 중에 헷갈리지 않는다.
 */

export interface AppConfig {
  appEnv: string;
  /**
   * 리다이렉트 링크의 뿌리. 카드 줄 링크가 전부 이걸로 만들어진다
   * (`redirectUrl`). 로컬 값을 운영에 넣으면 모든 링크가 죽는다.
   *
   * ⚠️ LOG_LEVEL 과 PORT 는 여기 없다 — 둘 다 Nest 앱을 만들기 **전에** 필요해서
   *    main.ts 가 process.env 로 직접 읽는다. 설정에 중복으로 두면 둘 중 어느 쪽이
   *    이기는지 헷갈린다.
   */
  publicBaseUrl: string;

  supabaseUrl: string;
  supabaseServiceRoleKey: string;

  adpickApiBase: string;
  adpickApiKey: string;
  adpickTimeoutMs: number;
  adpickLinkonly: boolean;
  adpickMaxConcurrency: number;
  adpickLinkTemplate: string;
  adpickLinkTtlDays: number;
  adpickSubidParam: string;

  kakaoSkillToken: string;
  kakaoCallbackTimeoutMs: number;
  debugToken: string;

  openaiApiKey: string;
  openaiApiBase: string;
  openaiProject: string;
  openaiOrganization: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  openaiSearchEffort: string;
  openaiRankEffort: string;
  openaiCandidateCount: number;
  openaiParseModel: string;
  openaiParseEffort: string;
  openaiParseTimeoutMs: number;

  intentCacheTtlMinutes: number;

  /** 한 번의 검색으로 저장하는 최대 건수. 5건씩 잘라 페이지로 낸다. */
  resultMaxItems: number;
  /** 실패한 검색을 기억해두는 시간. 짧게 둬야 재시도가 막히지 않는다. */
  failedTtlMinutes: number;
  /** pending 을 꽂아둔 채 죽은 검색을 다른 요청이 되찾아가기까지의 시간. */
  pendingTimeoutSeconds: number;

  hotelCacheTtlMinutes: number;

  flightCacheTtlMinutes: number;
  flightDefaultOriginName: string;
  flightDefaultOriginCode: string;

  attractionCacheTtlMinutes: number;
  attractionImages: boolean;
  attractionImageTimeoutMs: number;
  googlePlacesApiKey: string;
  googlePlacesTimeoutMs: number;
  attractionRefreshDays: number;

  moreButtonStyle: 'block' | 'message';
  fallbackBlockId: string;

  hotelThumbnails: boolean;
  hotelThumbnailTimeoutMs: number;
  hotelThumbnailMaxBytes: number;
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

export function loadConfig(): AppConfig {
  return {
    appEnv: str('APP_ENV', 'local'),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8000'),

    supabaseUrl: str('SUPABASE_URL'),
    supabaseServiceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),

    adpickApiBase: str('ADPICK_API_BASE', 'https://biz.adpick.co.kr'),
    adpickApiKey: str('ADPICK_API_KEY'),
    // 파이썬은 초 단위(ADPICK_TIMEOUT_SECONDS). 같은 값을 ms 로 환산해서 쓴다.
    adpickTimeoutMs: Math.round(num('ADPICK_TIMEOUT_SECONDS', 2) * 1000),
    adpickLinkonly: bool('ADPICK_LINKONLY', true),
    adpickMaxConcurrency: num('ADPICK_MAX_CONCURRENCY', 5),
    adpickLinkTemplate: str('ADPICK_LINK_TEMPLATE'),
    adpickLinkTtlDays: num('ADPICK_LINK_TTL_DAYS', 30),
    // 애드픽 커미션 링크는 임의 파라미터를 해석하지 않는다(p_data 가 그 역할). 기본 비활성.
    adpickSubidParam: str('ADPICK_SUBID_PARAM'),

    kakaoSkillToken: str('KAKAO_SKILL_TOKEN'),
    // 카카오는 콜백을 1분 안에 받는다. 그 안에 못 보내면 사용자는 아무것도 못 받는다.
    kakaoCallbackTimeoutMs: Math.round(num('KAKAO_CALLBACK_TIMEOUT_SECONDS', 10) * 1000),
    // 진단 엔드포인트(/api/v1/debug/*) 보호. 운영에서 비워두면 그 경로는 404 다.
    debugToken: str('DEBUG_TOKEN'),

    openaiApiKey: str('OPENAI_API_KEY'),
    openaiApiBase: str('OPENAI_API_BASE', 'https://api.openai.com/v1'),
    // 레거시 sk- 키는 조직의 **기본 프로젝트**로 붙는다. 다른 프로젝트에서 모델을
    // 허용해뒀다면 그 설정이 안 먹는다. 이 값을 채우면 그 프로젝트로 붙는다.
    // sk-proj- 키는 프로젝트가 키에 박혀 있으므로 비워두면 된다.
    openaiProject: str('OPENAI_PROJECT'),
    openaiOrganization: str('OPENAI_ORGANIZATION'),
    openaiModel: str('OPENAI_MODEL', 'gpt-5-mini'),
    // 웹 검색이 붙은 호출은 느리다. 5초 예산은 캐시가 지키고, 여긴 넉넉히 준다.
    openaiTimeoutMs: Math.round(num('OPENAI_TIMEOUT_SECONDS', 60) * 1000),
    // gpt-5 계열은 reasoning.effort 를 받는다: minimal | low | medium | high.
    // 올릴수록 결과가 좋아지지만 콜백 1분 예산을 잡아먹는다.
    openaiSearchEffort: str('OPENAI_SEARCH_EFFORT', 'low'),
    openaiRankEffort: str('OPENAI_RANK_EFFORT', 'low'),
    // ⚠️ RESULT_MAX_ITEMS(20)보다 넉넉히 커야 2차 호출이 "고르는" 일을 한다.
    //    같거나 작으면 후보를 전부 쓰게 되어 선별이 사실상 안 돈다 (부팅 때 경고).
    openaiCandidateCount: num('OPENAI_CANDIDATE_COUNT', 30),
    // 발화 파싱은 카카오 5초 예산 안에서 돈다. 생각을 시키면 안 된다.
    //
    // 검색용 모델과 분리한 이유: 검색은 품질이 중요하고 콜백 예산(1분)을 쓰지만,
    // 파싱은 "도시 이름 하나 뽑기"라 작은 모델로 충분하고 **속도가 곧 품질**이다.
    openaiParseModel: str('OPENAI_PARSE_MODEL', 'gpt-5-nano'),
    openaiParseEffort: str('OPENAI_PARSE_EFFORT', 'minimal'),
    // 2.5초는 너무 빡빡했다 — 실제 gpt-5 계열은 이 정도로는 못 끝낸다.
    // 넘기면 되묻기로 떨어지므로, 5초 예산이 허락하는 만큼은 기다려준다.
    openaiParseTimeoutMs: Math.round(num('OPENAI_PARSE_TIMEOUT_SECONDS', 4) * 1000),
    // ⚠️ NLU_ALIAS_TTL_MINUTES 는 없앴다. 지역 별칭("동경"→도쿄)은 시간이 지나도
    //    변하지 않는 사실이라 만료시킬 이유가 없고(PlacesService 참고), 문장 해석
    //    캐시는 INTENT_CACHE_TTL_MINUTES 가 맡는다. 읽지 않는 knob 을 남겨두면
    //    사람이 그걸 돌려보며 원인을 찾는다.
    // 단톡방은 같은 문장이 반복된다. 일주일이면 유행하는 질문 하나를 한 번만 산다.
    intentCacheTtlMinutes: num('INTENT_CACHE_TTL_MINUTES', 10080),

    // 20건을 한 행에 저장하고 5건씩 4페이지로 낸다.
    // ⚠️ 올릴수록 AI 가 뒤쪽 항목을 지어낼 여지가 커진다. 품질이 떨어지면 내려라.
    resultMaxItems: num('RESULT_MAX_ITEMS', 20),
    // 실패를 오래 기억하면 일시적 장애가 그 시간만큼 굳는다.
    failedTtlMinutes: num('FAILED_TTL_MINUTES', 10),
    // 검색은 보통 7~30초다. 그보다 넉넉히 잡되, 프로세스가 죽어 pending 이 남았을 때
    // 다음 사람이 영영 못 물어보는 일은 없어야 한다.
    pendingTimeoutSeconds: num('PENDING_TIMEOUT_SECONDS', 120),

    // 예약 페이지에서 대표 이미지를 긁어온다. 모델은 이미지 주소를 모른다(웹 검색은
    // 텍스트만 준다) — 그래서 시키면 지어낸다. 페이지에서 직접 읽는 게 유일한 정답이다.
    hotelThumbnails: bool('HOTEL_THUMBNAILS', true),
    hotelThumbnailTimeoutMs: Math.round(num('HOTEL_THUMBNAIL_TIMEOUT_SECONDS', 4) * 1000),
    // 예약 페이지는 200~400KB 다. 이미지 주소는 앞쪽에 있으므로 다 읽을 이유가 없다.
    hotelThumbnailMaxBytes: num('HOTEL_THUMBNAIL_MAX_KB', 512) * 1024,

    // ⚠️ HOTEL_PROVIDER / FLIGHT_PROVIDER / ATTRACTION_PROVIDER 는 없앴다.
    //    provider 는 모듈이 DI 로 꽂는다(지금은 openai 하나뿐). 설정으로 읽는 척만
    //    하고 있어서 .env 에 static 이라고 적어두면 OpenAI 를 부르면서 static 이라고
    //    보고했다. 소스를 바꾸려면 모듈을 고쳐야 하고, 실제 값은 /health 가 찍는다.
    // 호텔 요금은 하루 사이에도 바뀐다. 하루가 그 변동과 AI 호출 비용의 타협점이다.
    hotelCacheTtlMinutes: num('HOTEL_CACHE_TTL_MINUTES', 1440),

    // 운임은 하루에도 몇 번 바뀐다. 그래도 캐시를 끄지는 않는다 —
    // 그러면 같은 노선을 물을 때마다 웹 검색 요금이 그대로 나간다.
    flightCacheTtlMinutes: num('FLIGHT_CACHE_TTL_MINUTES', 360),
    // "오사카 항공권" 처럼 출발지를 안 말하는 게 보통이다. 되묻는 대신 여기서 출발한다고
    // 보고, 카드 아래 안내에 '서울 출발' 을 적어 사용자가 바로 고쳐 말할 수 있게 한다.
    flightDefaultOriginName: str('FLIGHT_DEFAULT_ORIGIN_NAME', '서울'),
    flightDefaultOriginCode: str('FLIGHT_DEFAULT_ORIGIN_CODE', 'ICN'),

    // 호텔 요금·항공 운임과 달리 **오사카의 볼거리는 어제와 오늘이 같다.**
    // 짧게 잡을수록 같은 답을 다시 사는 셈이라 30일로 둔다.
    attractionCacheTtlMinutes: num('ATTRACTION_CACHE_TTL_MINUTES', 43200),
    // 카드 썸네일을 위키백과에서 찾을지. 끄면 사진 없는 카드로 돌아간다.
    attractionImages: bool('ATTRACTION_IMAGES', true),
    // 콜백 경로에서만 도는 호출이라 5초 예산과 무관하다. 그래도 짧게 끊는 이유는
    // 여러 곳을 동시에 찾기 때문이다 — 하나가 늘어지면 카드 전체가 그만큼 늦는다.
    attractionImageTimeoutMs: Math.round(num('ATTRACTION_IMAGE_TIMEOUT_SECONDS', 3) * 1000),

    // 관광지 후보와 사실 데이터의 출처. **없으면 관광지 검색이 통째로 안 된다** —
    // 모델만으로는 없는 곳을 섞기 때문에 그 구성을 지원하지 않는다.
    googlePlacesApiKey: str('GOOGLE_PLACES_API_KEY', ''),
    // 도시 하나에 타입별로 여러 번 부른다. 하나가 늘어지면 그만큼 늦으므로 짧게 끊는다.
    googlePlacesTimeoutMs: Math.round(num('GOOGLE_PLACES_TIMEOUT_SECONDS', 5) * 1000),
    // ⚠️ **캐시 TTL(30일)보다 짧아야 한다.** 만료된 뒤에 갱신하면 그 도시의 첫 질문이
    //    다시 대기를 타므로 미리 채워두는 의미가 없어진다.
    attractionRefreshDays: num('ATTRACTION_REFRESH_DAYS', 28),

    // "더 보기" 버튼 방식. block 이면 clientExtra 로 cache_key·offset 을 실어 보낼 수
    // 있어 서버가 상태를 안 들고도 4페이지까지 간다.
    // ⚠️ 그룹챗방에서 action:'block' 이 되는지 확인되지 않았다. itemCard 처럼 안 되면
    //    message 로 내리면 된다 — 그 경우 발화자별 커서를 서버가 짧게 기억한다.
    moreButtonStyle: str('MORE_BUTTON_STYLE', 'block') === 'message' ? 'message' : 'block',
    // 폴백 블록 ID. 시나리오 블록을 전부 지웠으므로 더보기 버튼이 부를 블록은
    // 폴백 하나뿐이다.
    //
    // ⚠️ 비워두면 **요청이 알려준 블록 ID**를 쓴다 (userRequest.block.id). 라우터로
    //    들어온 요청은 곧 폴백 블록이 부른 요청이므로 그게 정답이고, 블록을 다시
    //    만들어 ID 가 바뀌어도 저절로 따라간다. 설정은 그걸 덮어쓰고 싶을 때만 쓴다.
    fallbackBlockId: str('KAKAO_BLOCK_ID_FALLBACK'),
  };
}

/** @deprecated database.config 의 isDatabaseEnabled 와 같다. 호출부 호환용. */
export { isDatabaseEnabled as dbEnabled } from './database.config';

export const adpickApiEnabled = (c: AppConfig): boolean =>
  Boolean(c.adpickApiKey && c.adpickApiBase);

/** 키가 없으면 AI provider 는 검색을 시도하지 않고 빈 결과를 준다. */
export const openaiEnabled = (c: AppConfig): boolean =>
  Boolean(c.openaiApiKey && c.openaiApiBase && c.openaiModel);

export const redirectUrl = (c: AppConfig, clickId: string): string =>
  `${c.publicBaseUrl.replace(/\/+$/, '')}/r/${clickId}`;

export const CONFIG = 'APP_CONFIG';

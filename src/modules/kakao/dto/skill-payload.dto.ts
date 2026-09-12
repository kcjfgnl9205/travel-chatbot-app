/**
 * 카카오 i 오픈빌더 스킬 요청 페이로드.
 *
 * 오픈빌더는 필드를 조금씩 바꿔서 보내기도 하므로 전부 optional 로 두고
 * 접근자를 통해 안전하게 읽는다. 검증으로 요청을 거절하지 않는 게 중요하다 —
 * 카카오에 400 을 주면 사용자에게는 원인 불명 오류만 뜬다.
 */

export interface KakaoSkillPayload {
  userRequest?: {
    utterance?: string;
    user?: { id?: string; type?: string; properties?: Record<string, unknown> };
    block?: { id?: string; name?: string };
    params?: Record<string, unknown>;
    callbackUrl?: string;
  };
  action?: {
    id?: string;
    name?: string;
    params?: Record<string, unknown>;
    detailParams?: Record<string, unknown>;
    clientExtra?: Record<string, unknown>;
  };
  bot?: Record<string, unknown>;
  intent?: Record<string, unknown>;
}

export function utteranceOf(p: KakaoSkillPayload): string {
  return (p.userRequest?.utterance ?? '').trim();
}

/** 사용자 식별자. botUserKey 우선, 없으면 user.id. */
export function userKeyOf(p: KakaoSkillPayload): string {
  const props = p.userRequest?.user?.properties ?? {};
  return String(
    props.botUserKey ?? props.plusfriendUserKey ?? p.userRequest?.user?.id ?? 'unknown',
  );
}

export function blockNameOf(p: KakaoSkillPayload): string | null {
  return p.userRequest?.block?.name ?? null;
}

/**
 * 콜백 주소.
 *
 * **오픈빌더에서 그 블록의 콜백을 켠 경우에만 실린다.** 즉 이 값의 존재 여부가
 * "지금 콜백을 써도 되는가"의 유일한 판단 근거다. 꺼져 있는데 useCallback 을 보내면
 * 사용자는 아무 말풍선도 받지 못한다.
 */
export function callbackUrlOf(p: KakaoSkillPayload): string | null {
  const url = p.userRequest?.callbackUrl;
  return typeof url === 'string' && url.startsWith('http') ? url : null;
}

export function actionParamsOf(p: KakaoSkillPayload): Record<string, unknown> {
  return p.action?.params ?? {};
}

/**
 * 오픈빌더 파라미터를 읽는다.
 *
 * **detailParams 를 먼저 본다.** 커스텀 엔티티가 매칭되면 카카오는 원문(origin)과
 * 엔티티 대표값(value)을 함께 담아주는데, 우리가 원하는 건 대표값이다
 * ("동경" 이라고 쳐도 대표값은 "도쿄"). action.params 는 대표값만 있을 때도
 * 있고 없을 때도 있어 보조로 둔다.
 *
 * ⚠️ 시스템 엔티티(sys.*)는 value 를 `{"value":"서울"}` 같은 JSON **문자열**로
 *    보낼 때가 있다. 그대로 String() 하면 도시명이 중괄호째 검색어가 된다.
 */
export function paramOf(p: KakaoSkillPayload, ...names: string[]): string | null {
  for (const name of names) {
    const detail = p.action?.detailParams?.[name];
    if (detail && typeof detail === 'object' && 'value' in detail) {
      const value = paramText((detail as { value?: unknown }).value);
      if (value) return value;
    }

    const direct = paramText(p.action?.params?.[name]);
    if (direct) return direct;

    const fromRequest = paramText(p.userRequest?.params?.[name]);
    if (fromRequest) return fromRequest;
  }
  return null;
}

/** 파라미터 한 칸을 문자열로 편다. 빈 값·'null'·sys 엔티티 JSON 을 걸러낸다. */
function paramText(raw: unknown): string | null {
  if (raw == null) return null;

  let text = String(raw).trim();
  if (text.startsWith('{')) {
    try {
      const unwrapped = (JSON.parse(text) as { value?: unknown })?.value;
      if (unwrapped != null) text = String(unwrapped).trim();
    } catch {
      // 평문으로 취급한다. 도시명이 '{' 로 시작할 일은 없지만 버리지는 않는다.
    }
  }

  if (!text || text.toLowerCase() === 'null' || text === 'undefined') return null;
  return text;
}

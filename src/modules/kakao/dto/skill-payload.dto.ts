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

/**
 * 사용자가 친 문장. **봇 멘션은 떼어낸다.**
 *
 * ⚠️ 단톡방에서는 모든 발화가 "@여행메이트 ..." 로 시작한다. 그런데 봇 이름에
 *    **"여행" 이 들어 있어서** 멘션을 안 떼면 "@여행메이트 안녕 다들 뭐해?" 같은
 *    잡담이 1차 필터(TRAVEL_HINT)를 통과해 버린다. 인사말 한 줄이 모델 호출 한 번이
 *    되고, 그게 방 인원수만큼 곱해진다.
 */
export function utteranceOf(p: KakaoSkillPayload): string {
  const raw = (p.userRequest?.utterance ?? '').trim();
  const botName = typeof p.bot?.name === 'string' ? p.bot.name.trim() : '';

  // 봇 이름은 공백을 포함할 수 있다 ("여행메이트 TST"). 이름을 알면 그걸 먼저 떼고,
  // 모르면 맨 앞의 @토큰 하나를 뗀다.
  let text = raw;
  if (botName && text.startsWith(`@${botName}`)) {
    text = text.slice(botName.length + 1);
  }
  return text.replace(/^@\S+\s*/, '').trim();
}

/** 사용자 식별자. botUserKey 우선, 없으면 user.id. */
export function userKeyOf(p: KakaoSkillPayload): string {
  const props = p.userRequest?.user?.properties ?? {};
  return String(
    props.botUserKey ?? props.plusfriendUserKey ?? p.userRequest?.user?.id ?? 'unknown',
  );
}

/** 봇 이름. 단톡방에서 "@여행메이트 다낭" 처럼 멘션을 안내할 때 쓴다. */
export function botNameOf(p: KakaoSkillPayload): string | null {
  const name = p.bot?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

export function blockNameOf(p: KakaoSkillPayload): string | null {
  return p.userRequest?.block?.name ?? null;
}

/**
 * 요청을 보낸 블록의 ID.
 *
 * **"더 보기" 버튼이 부를 블록이 곧 이 블록이다.** 시나리오 블록을 전부 지웠으므로
 * 라우터로 들어온 요청은 폴백 블록이 부른 것이고, 그래서 설정 없이도 버튼이 산다 —
 * 블록을 다시 만들어 ID 가 바뀌어도 저절로 따라간다.
 */
export function blockIdOf(p: KakaoSkillPayload): string {
  const id = p.userRequest?.block?.id;
  return typeof id === 'string' ? id.trim() : '';
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

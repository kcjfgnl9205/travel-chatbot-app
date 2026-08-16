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

export function actionParamsOf(p: KakaoSkillPayload): Record<string, unknown> {
  return p.action?.params ?? {};
}

/** action.params → detailParams.value → userRequest.params 순으로 조회. */
export function paramOf(p: KakaoSkillPayload, ...names: string[]): string | null {
  for (const name of names) {
    const direct = p.action?.params?.[name];
    if (direct) return String(direct);

    const detail = p.action?.detailParams?.[name];
    if (detail && typeof detail === 'object' && 'value' in detail) {
      const value = (detail as { value?: unknown }).value;
      if (value) return String(value);
    }

    const fromRequest = p.userRequest?.params?.[name];
    if (fromRequest) return String(fromRequest);
  }
  return null;
}

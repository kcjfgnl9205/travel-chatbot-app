/**
 * 카카오 스킬 응답(SkillResponse) JSON 빌더.
 *
 * https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format
 *
 * 카카오는 길이/개수 제한을 넘기면 말풍선이 통째로 렌더링되지 않는다.
 * 그래서 빌더 단계에서 잘라 넣는다.
 */

export const MAX_QUICK_REPLIES = 10;
export const MAX_QUICK_REPLY_LABEL = 14;
export const MAX_BUTTON_LABEL = 14;

// --- listCard
export const MAX_LIST_ITEMS = 5; // 한 카드에 5줄. 이 한계가 곧 페이지 크기다
export const MAX_LIST_BUTTONS = 2;
export const MAX_LIST_HEADER_TITLE = 40;
export const MAX_LIST_ITEM_TITLE = 40; // 2줄
export const MAX_LIST_ITEM_DESC = 40; // 1줄

export type Json = Record<string, unknown>;

export function cut(text: string | null | undefined, limit: number): string {
  const t = (text ?? '').trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit - 1).trimEnd() + '…';
}

// ------------------------------------------------------------------ 공통 조각
export function quickReply(label: string, messageText?: string): Json {
  return {
    label: cut(label, MAX_QUICK_REPLY_LABEL),
    action: 'message',
    messageText: messageText ?? label,
  };
}

export function messageButton(label: string, messageText: string): Json {
  return {
    label: cut(label, MAX_BUTTON_LABEL),
    action: 'message',
    messageText,
  };
}

export function webLinkButton(label: string, url: string): Json {
  return {
    action: 'webLink',
    label: cut(label, MAX_BUTTON_LABEL),
    webLinkUrl: url,
  };
}

export function skillResponse(outputs: Json[], quickReplies?: Json[]): Json {
  const template: Json = { outputs };
  if (quickReplies?.length) {
    template.quickReplies = quickReplies.slice(0, MAX_QUICK_REPLIES);
  }
  return { version: '2.0', template };
}

export function simpleText(text: string, quickReplies?: Json[]): Json {
  return skillResponse([{ simpleText: { text } }], quickReplies);
}

/**
 * 콜백 예약 응답.
 *
 * "지금은 이 문구만 보여주고, 진짜 답은 곧 callbackUrl 로 보내겠다"는 뜻이다.
 * 카카오는 이걸 5초 안에 받아야 하고, 그 뒤 1분 안에 콜백이 와야 한다.
 *
 * ⚠️ 오픈빌더에서 해당 스킬 블록의 **콜백 사용**이 켜져 있어야 동작한다.
 *    꺼져 있으면 이 응답은 무시되고 사용자는 아무것도 못 본다.
 *    (그래서 payload 에 callbackUrl 이 있을 때만 쓴다 — 그게 켜졌다는 증거다)
 */
export function callbackAck(text: string): Json {
  return { version: '2.0', useCallback: true, data: { text } };
}

// ------------------------------------------------------------------- listCard
export interface ListItemInput {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  linkUrl?: string | null;
  /**
   * 줄을 누르면 이 문장이 사용자 발화로 전송된다 (`action: "message"`).
   *
   * 검색 결과 줄은 `linkUrl`(예약 페이지)을 쓰고, **고르라고 내놓는 목록**은 이걸 쓴다.
   * 단톡방에서는 봇을 멘션한 메시지만 서버로 오기 때문에, 사용자가 직접 타이핑하게
   * 두면 멘션을 빠뜨려 아무 일도 안 일어난다 — 눌러서 보내는 길이 있어야 한다.
   *
   * ⚠️ `linkUrl` 과 같이 주면 안 된다. 카카오는 하나만 처리한다.
   */
  messageText?: string | null;
}

/**
 * 리스트 한 줄. `link` 를 주면 줄 전체가 클릭 가능해진다.
 *
 * 호텔 목록에서는 이 링크가 우리 리다이렉트(`/r/{clickId}`)를 가리켜야
 * "사용자가 어떤 호텔을 골랐는지"가 기록된다.
 */
export function listItem(input: ListItemInput): Json {
  const item: Json = { title: cut(input.title, MAX_LIST_ITEM_TITLE) };
  if (input.description) {
    item.description = cut(input.description, MAX_LIST_ITEM_DESC);
  }
  if (input.imageUrl) item.imageUrl = input.imageUrl;
  if (input.linkUrl) item.link = { web: input.linkUrl };
  else if (input.messageText) {
    item.action = 'message';
    item.messageText = input.messageText;
  }
  return item;
}

export interface ListCardInput {
  headerTitle: string;
  items: Json[];
  buttons?: Json[];
  quickReplies?: Json[];
}

/** 제목 + 항목 리스트 말풍선. `items` 는 최소 1개 필요하다. */
export function listCard(input: ListCardInput): Json {
  const card: Json = {
    header: { title: cut(input.headerTitle, MAX_LIST_HEADER_TITLE) },
    items: input.items.slice(0, MAX_LIST_ITEMS),
  };
  if (input.buttons?.length) {
    card.buttons = input.buttons.slice(0, MAX_LIST_BUTTONS);
  }
  return skillResponse([{ listCard: card }], input.quickReplies);
}

/**
 * 카드 + 그 아래 안내 말풍선.
 *
 * ⚠️ **안내를 카드 안에 넣을 자리가 없다.** listCard 의 header 는 40자고 줄 설명도
 *    40자다. "AI 가 정리한 참고 정보" 와 "날짜·인원은 반영되지 않았다" 는 둘 다
 *    거기 안 들어가는데, 둘 다 없으면 사용자가 결과를 사실로 믿는다.
 *    그래서 말풍선을 하나 더 세운다 (카카오는 outputs 를 3개까지 받는다).
 *
 * 순서가 중요하다 — **카드가 먼저다.** 안내가 위에 오면 결과를 가린다.
 */
export function listCardWithNotice(
  input: ListCardInput,
  notice: string,
  quickReplies?: Json[],
): Json {
  const card: Json = {
    header: { title: cut(input.headerTitle, MAX_LIST_HEADER_TITLE) },
    items: input.items.slice(0, MAX_LIST_ITEMS),
  };
  if (input.buttons?.length) card.buttons = input.buttons.slice(0, MAX_LIST_BUTTONS);

  const outputs: Json[] = [{ listCard: card }];
  if (notice.trim()) outputs.push({ simpleText: { text: notice.trim() } });
  return skillResponse(outputs, quickReplies ?? input.quickReplies);
}

/**
 * 블록을 부르는 버튼. **extra 가 서버로 그대로 돌아온다** (`action.clientExtra`).
 *
 * "더 보기" 가 이걸 쓴다 — 커서(cache_key·offset)를 버튼이 들고 다니므로 서버는
 * 누가 어디까지 봤는지 기억하지 않아도 된다.
 *
 * ⚠️ 그룹챗방에서 `action: "block"` 이 동작하는지 확인되지 않았다. 안 되면
 *    MORE_BUTTON_STYLE=message 로 내린다 (messageButton 경로).
 */
export function blockButton(input: {
  label: string;
  blockId: string;
  messageText: string;
  extra?: Json;
}): Json {
  const button: Json = {
    label: cut(input.label, MAX_BUTTON_LABEL),
    action: 'block',
    blockId: input.blockId,
    messageText: input.messageText,
  };
  if (input.extra) button.extra = input.extra;
  return button;
}

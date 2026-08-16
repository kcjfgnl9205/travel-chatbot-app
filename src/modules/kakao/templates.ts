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
export const MAX_LIST_ITEMS = 5; // 단독형 5개 (캐러셀에 넣으면 4개로 줄어든다)
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

// ------------------------------------------------------------------- listCard
export interface ListItemInput {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  linkUrl?: string | null;
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

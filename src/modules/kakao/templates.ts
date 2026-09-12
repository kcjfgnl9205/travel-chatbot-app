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

// ------------------------------------------------------------------- itemCard
/**
 * itemCard 제한.
 *
 * 항공권은 listCard 로 담을 수 없다. 한 줄에 40자뿐인데 항공권 1건은
 * "항공사 · 편명 · 출발/도착 시각 · 소요 · 경유 · 가격" 이 다 있어야 고를 수 있다.
 * itemCard 는 key-value 줄을 5개까지 세로로 쌓을 수 있어서 그게 들어간다.
 *
 * ⚠️ 카카오는 제한을 넘기면 **말풍선을 통째로 렌더링하지 않는다.** 그래서
 *    "잘려서 보기 나쁘다" 가 아니라 "아무것도 안 보인다" 가 된다. 여기서 잘라 넣는다.
 *    itemList 의 title 6자는 특히 빡빡하다 ('항공사' 3자, '가는편' 3자).
 */
export const MAX_ITEM_CARD_HEAD = 30; // head.title 2줄
export const MAX_ITEM_LIST_ROWS = 5;
export const MAX_ITEM_LIST_TITLE = 6;
export const MAX_ITEM_LIST_DESC = 20; // 1줄
export const MAX_ITEM_CARD_TITLE = 30; // 2줄
export const MAX_ITEM_CARD_DESC = 60; // 3줄
export const MAX_ITEM_CARD_BUTTONS = 3;

/** 캐러셀에 담을 수 있는 카드 수. */
export const MAX_CAROUSEL_ITEMS = 10;

export interface ItemRow {
  title: string;
  description: string;
}

export interface ItemCardInput {
  /** 카드 맨 위 굵은 줄. 항공권은 여기에 노선과 날짜를 넣는다. */
  headTitle?: string | null;
  imageUrl?: string | null;
  /** key-value 줄. 최대 5개, key 는 6자까지다. */
  itemList: ItemRow[];
  /** 값을 오른쪽으로 붙인다. 숫자·시각이 세로로 정렬돼 비교하기 쉬워진다. */
  itemListAlignment?: 'left' | 'right';
  /** 강조되는 마지막 줄. 가격을 여기 넣는다. */
  summary?: ItemRow | null;
  title?: string | null;
  description?: string | null;
  buttons?: Json[];
  buttonLayout?: 'vertical' | 'horizontal';
}

/**
 * 항목 나열형 카드.
 *
 * itemList 가 최소 1개는 있어야 한다 — 없으면 카카오가 렌더링을 거부한다.
 * 그래서 빈 목록이면 이걸 부르지 말고 simpleText 로 떨어져야 한다.
 */
export function itemCard(input: ItemCardInput): Json {
  const card: Json = {
    itemList: input.itemList.slice(0, MAX_ITEM_LIST_ROWS).map((row) => ({
      title: cut(row.title, MAX_ITEM_LIST_TITLE),
      description: cut(row.description, MAX_ITEM_LIST_DESC),
    })),
  };

  if (input.headTitle) card.head = { title: cut(input.headTitle, MAX_ITEM_CARD_HEAD) };
  if (input.imageUrl) card.thumbnail = { imageUrl: input.imageUrl };
  if (input.itemListAlignment) card.itemListAlignment = input.itemListAlignment;
  if (input.summary) {
    card.itemListSummary = {
      title: cut(input.summary.title, MAX_ITEM_LIST_TITLE),
      description: cut(input.summary.description, MAX_ITEM_LIST_DESC),
    };
  }
  if (input.title) card.title = cut(input.title, MAX_ITEM_CARD_TITLE);
  if (input.description) card.description = cut(input.description, MAX_ITEM_CARD_DESC);
  if (input.buttons?.length) {
    card.buttons = input.buttons.slice(0, MAX_ITEM_CARD_BUTTONS);
    card.buttonLayout = input.buttonLayout ?? 'vertical';
  }
  return card;
}

// ------------------------------------------------------------------- carousel
/**
 * 같은 종류의 카드를 좌우로 넘기는 말풍선.
 *
 * ⚠️ **items 안에는 카드 본체만 들어간다.** `{ itemCard: {...} }` 로 감싼 걸 넣으면
 *    렌더링되지 않는다 — 감싸는 건 카드가 단독으로 나갈 때뿐이다.
 */
export function carousel(
  type: 'basicCard' | 'commerceCard' | 'listCard' | 'itemCard',
  items: Json[],
  quickReplies?: Json[],
): Json {
  return skillResponse(
    [{ carousel: { type, items: items.slice(0, MAX_CAROUSEL_ITEMS) } }],
    quickReplies,
  );
}

/**
 * 안내 문구 + 캐러셀.
 *
 * 캐러셀에는 listCard 의 header 같은 자리가 없다. 노선·인원·"가격은 검색 시점 기준"
 * 같은 공통 맥락을 카드마다 반복해 넣을 수는 없으니 앞에 말풍선 하나로 세운다.
 * (카카오는 outputs 를 3개까지 받는다)
 */
/**
 * 안내 문구 + 리스트 카드.
 *
 * ⚠️ **그룹챗봇(팀톡방)은 itemCard 를 못 그린다 — 말풍선이 통째로 사라진다.**
 *    호텔·관광지가 같은 방에서 멀쩡한 건 listCard 라서다. 항공권도 같은 모양으로
 *    맞추되, 노선·조건·"예상가" 안내는 listCard header(40자)에 안 들어가므로
 *    캐러셀 때와 마찬가지로 앞에 말풍선 하나를 세운다.
 *
 * 그 말풍선이 들고 가는 게 둘 있다. 둘 다 없애면 안 된다.
 *   · **출발지를 추측했다는 사실** — 부산에서 가려던 사람이 고쳐 말할 유일한 단서
 *   · **가격이 확정 운임이 아니라는 말** — 없으면 카드 가격을 믿고 눌렀다 배신당한다
 */
export function textThenListCard(
  text: string,
  card: ListCardInput,
  quickReplies?: Json[],
): Json {
  const listCard: Json = {
    header: { title: cut(card.headerTitle, MAX_LIST_HEADER_TITLE) },
    items: card.items.slice(0, MAX_LIST_ITEMS),
  };
  if (card.buttons?.length) listCard.buttons = card.buttons.slice(0, MAX_LIST_BUTTONS);

  return skillResponse([{ simpleText: { text } }, { listCard }], quickReplies);
}

export function textThenCarousel(
  text: string,
  type: 'basicCard' | 'commerceCard' | 'listCard' | 'itemCard',
  items: Json[],
  quickReplies?: Json[],
): Json {
  return skillResponse(
    [
      { simpleText: { text } },
      { carousel: { type, items: items.slice(0, MAX_CAROUSEL_ITEMS) } },
    ],
    quickReplies,
  );
}

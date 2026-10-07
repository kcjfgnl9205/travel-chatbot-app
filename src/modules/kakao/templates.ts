/**
 * 카카오 스킬 응답(SkillResponse) JSON 빌더.
 *
 * https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format
 *
 * 카카오는 길이/개수 제한을 넘기면 말풍선이 통째로 렌더링되지 않는다.
 * 그래서 빌더 단계에서 잘라 넣는다.
 */

export const MAX_BUTTON_LABEL = 14;

/**
 * 한 응답에 넣을 수 있는 말풍선 수.
 *
 * ⚠️ 넘기면 **응답 전체가 렌더링되지 않는다.** 결과 카드 + 고지 + 멘션 버튼이
 *    정확히 3개라 여유가 없다. 여기서 잘라 넣어 카드까지 같이 사라지는 일을 막는다.
 */
export const MAX_OUTPUTS = 3;

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
/**
 * **챗봇을 멘션하는 버튼.** 누르면 입력창에 `@봇이름` 이 들어간다.
 *
 * 단톡방에서는 봇을 멘션한 메시지만 서버로 온다. 그래서 "오사카 호텔 추천해줘" 라고만
 * 치면 **봇이 아예 듣지 못하고**, 사용자에게는 봇이 죽은 것처럼 보인다 — 실제로 그렇게
 * 대화가 끊겼다. 이 버튼이 그 턱을 없앤다.
 *
 * ⚠️ **문장까지 넣어주지는 않는다.** 들어가는 건 멘션뿐이고 나머지는 사용자가 친다.
 *    그래서 이 버튼을 다는 자리에는 "뭐라고 치면 되는지" 예문이 같이 있어야 한다.
 *
 * ⚠️ 액션 이름은 **`mention`** 이다. 예전에 문서에 없는 `talk_mention` 을 써봤더니
 *    응답 전체가 렌더링되지 않아 카드까지 같이 사라졌다. 그룹 챗봇 beta 개발 가이드의
 *    "봇 응답 버튼 플러그인" 표에 있는 이름이 이것이다.
 */
export function mentionButton(botName: string | null): Json {
  const name = botName?.trim();
  return {
    label: cut(name ? `@${name}` : '챗봇 멘션하기', MAX_BUTTON_LABEL),
    action: 'mention',
  };
}

/**
 * 멘션 버튼을 담은 말풍선. **퀵리플라이가 있던 자리를 대신한다.**
 *
 * ⚠️ 팀채팅 챗봇은 **QuickReplies 를 지원하지 않는다**(그룹 챗봇 beta 가이드 표 3).
 *    한동안 모든 응답에 퀵리플라이를 달아뒀는데 단톡방에서는 아무것도 안 보였다 —
 *    되묻는 말만 있고 누를 게 없으니 거기서 대화가 끊겼다.
 */
export function mentionCard(botName: string | null): Json {
  const name = botName?.trim() ?? '챗봇';
  return textCard({
    description: `${name}에게 이어서 말하기`,
    buttons: [mentionButton(botName)],
  });
}

export function messageButton(label: string, messageText: string): Json {
  return {
    label: cut(label, MAX_BUTTON_LABEL),
    action: 'message',
    messageText,
  };
}

/**
 * 말풍선을 다른 방으로 공유하는 버튼.
 *
 * **서버로 아무것도 안 돌아온다.** `message`·`block` 과 달리 카카오 클라이언트가
 * 공유창을 띄우고 끝이라 `label` 외에 실을 것이 없고, 누가 공유했는지도 알 수 없다
 * (추적이 필요하면 카드 안의 `/r/{clickId}` · `/a/{id}` 링크가 그 일을 한다).
 *
 * ⚠️ **공유된 카드의 링크는 그대로 살아 있어야 한다.** 관광지는 `/a/{id}` 라 괜찮지만
 *    호텔·항공권의 `/r/{clickId}` 는 노출마다 발급되는 값이라, 공유받은 사람이 눌러도
 *    **원래 공유한 사람의 클릭으로 집계된다.** 수수료는 어차피 애드픽 subid 단위라
 *    문제가 없고, 그래서 지금 구조를 안 바꾼다 — 다만 통계를 볼 때 이걸 알아야 한다.
 */
export function shareButton(label = '공유하기'): Json {
  return {
    label: cut(label, MAX_BUTTON_LABEL),
    action: 'share',
  };
}

export function skillResponse(outputs: Json[]): Json {
  return { version: '2.0', template: { outputs: outputs.slice(0, MAX_OUTPUTS) } };
}

/** 글만 있는 응답. 누를 것이 필요하면 `simpleTextWithMention` 을 쓴다. */
export function simpleText(text: string): Json {
  return skillResponse([{ simpleText: { text } }]);
}

/**
 * 글 + "이어서 말하기" 버튼.
 *
 * 되묻기와 오류 문구가 전부 이걸 쓴다. **대화가 거기서 끊기면 안 되는 자리**라,
 * 누를 것을 같이 줘야 한다 — 퀵리플라이로 하던 일이다.
 */
export function simpleTextWithMention(text: string, botName: string | null): Json {
  return skillResponse([{ simpleText: { text } }, mentionCard(botName)]);
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
}

/** 제목 + 항목 리스트 말풍선. `items` 는 최소 1개 필요하다. */
export function listCard(input: ListCardInput, botName: string | null): Json {
  return skillResponse([{ listCard: listCardOf(input) }, mentionCard(botName)]);
}

/** listCard 말풍선 하나. 길이 제한은 여기서 한 번만 건다. */
function listCardOf(input: ListCardInput): Json {
  const card: Json = {
    header: { title: cut(input.headerTitle, MAX_LIST_HEADER_TITLE) },
    items: input.items.slice(0, MAX_LIST_ITEMS),
  };
  if (input.buttons?.length) {
    card.buttons = input.buttons.slice(0, MAX_LIST_BUTTONS);
  }
  return card;
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
 *
 * ⚠️ 카드 + 고지 + 멘션 버튼이면 **정확히 3개로 꽉 찬다.** 여기에 말풍선을 하나 더
 *    얹으면 MAX_OUTPUTS 에서 잘려 멘션 버튼이 조용히 사라진다.
 */
export function listCardWithNotice(
  input: ListCardInput,
  notice: string,
  botName: string | null,
): Json {
  const outputs: Json[] = [{ listCard: listCardOf(input) }];
  if (notice.trim()) outputs.push({ simpleText: { text: notice.trim() } });
  outputs.push(mentionCard(botName));
  return skillResponse(outputs);
}

// ------------------------------------------------------------------- textCard
export const MAX_TEXT_CARD_TITLE = 50;
export const MAX_TEXT_CARD_DESC = 400;
export const MAX_TEXT_CARD_BUTTONS = 3;

export interface TextCardInput {
  title?: string | null;
  description: string;
  buttons?: Json[];
}

/**
 * 제목 + 설명 + 버튼 말풍선. **카드 뒤에 붙이는 안내 영역**으로 쓴다.
 *
 * listCard 의 버튼(2개)과 달리 여기는 설명을 길게 쓸 수 있어서, "이럴 땐 이렇게
 * 하세요" 같은 안내가 들어간다. 말풍선이 하나 더 늘지만 카드 안에 우겨넣는 것보다
 * 읽힌다 — listCard 의 줄 설명은 40자에서 잘린다.
 */
export function textCard(input: TextCardInput): Json {
  const card: Json = { description: cut(input.description, MAX_TEXT_CARD_DESC) };
  if (input.title) card.title = cut(input.title, MAX_TEXT_CARD_TITLE);
  if (input.buttons?.length) card.buttons = input.buttons.slice(0, MAX_TEXT_CARD_BUTTONS);
  return { textCard: card };
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

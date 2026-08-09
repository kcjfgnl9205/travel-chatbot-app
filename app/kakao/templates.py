"""카카오 스킬 응답(SkillResponse) JSON 빌더.

https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format

카카오는 길이/개수 제한을 넘기면 말풍선이 통째로 렌더링되지 않는다.
그래서 빌더 단계에서 잘라 넣는다.
"""

from typing import Any

MAX_QUICK_REPLIES = 10
MAX_QUICK_REPLY_LABEL = 14
MAX_BUTTON_LABEL = 14

# --- listCard
MAX_LIST_ITEMS = 5           # 단독형 5개 (캐러셀에 넣으면 4개로 줄어든다)
MAX_LIST_BUTTONS = 2
MAX_LIST_HEADER_TITLE = 40
MAX_LIST_ITEM_TITLE = 40     # 2줄
MAX_LIST_ITEM_DESC = 40      # 1줄


def _cut(text: str | None, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


# ------------------------------------------------------------------ 공통 조각
def quick_reply(label: str, message_text: str | None = None) -> dict[str, Any]:
    return {
        "label": _cut(label, MAX_QUICK_REPLY_LABEL),
        "action": "message",
        "messageText": message_text or label,
    }


def quick_reply_block(
    label: str, block_id: str, extra: dict | None = None
) -> dict[str, Any]:
    """다음 블록을 직접 호출하는 퀵리플라이. extra 는 다음 스킬의 clientExtra 로 전달된다."""
    item: dict[str, Any] = {
        "label": _cut(label, MAX_QUICK_REPLY_LABEL),
        "action": "block",
        "blockId": block_id,
    }
    if extra:
        item["extra"] = extra
    return item


def message_button(label: str, message_text: str) -> dict[str, Any]:
    return {
        "label": _cut(label, MAX_BUTTON_LABEL),
        "action": "message",
        "messageText": message_text,
    }


def web_link_button(label: str, url: str) -> dict[str, Any]:
    return {
        "action": "webLink",
        "label": _cut(label, MAX_BUTTON_LABEL),
        "webLinkUrl": url,
    }


def skill_response(
    outputs: list[dict[str, Any]],
    quick_replies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    template: dict[str, Any] = {"outputs": outputs}
    if quick_replies:
        template["quickReplies"] = quick_replies[:MAX_QUICK_REPLIES]
    return {"version": "2.0", "template": template}


def simple_text(
    text: str, quick_replies: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return skill_response([{"simpleText": {"text": text}}], quick_replies)


# ------------------------------------------------------------------- listCard
def list_item(
    *,
    title: str,
    description: str | None = None,
    image_url: str | None = None,
    link_url: str | None = None,
) -> dict[str, Any]:
    """리스트 한 줄. `link` 를 주면 줄 전체가 클릭 가능해진다.

    호텔 목록에서는 이 링크가 우리 리다이렉트(`/r/{click_id}`)를 가리켜야
    "사용자가 어떤 호텔을 골랐는지"가 기록된다.
    """
    item: dict[str, Any] = {"title": _cut(title, MAX_LIST_ITEM_TITLE)}
    if description:
        item["description"] = _cut(description, MAX_LIST_ITEM_DESC)
    if image_url:
        item["imageUrl"] = image_url
    if link_url:
        item["link"] = {"web": link_url}
    return item


def list_card(
    *,
    header_title: str,
    items: list[dict[str, Any]],
    buttons: list[dict[str, Any]] | None = None,
    quick_replies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """제목 + 항목 리스트 말풍선. `items` 는 최소 1개 필요하다."""
    card: dict[str, Any] = {
        "header": {"title": _cut(header_title, MAX_LIST_HEADER_TITLE)},
        "items": items[:MAX_LIST_ITEMS],
    }
    if buttons:
        card["buttons"] = buttons[:MAX_LIST_BUTTONS]
    return skill_response([{"listCard": card}], quick_replies)

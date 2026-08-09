"""카카오 스킬 응답(SkillResponse) JSON 빌더.

카카오 렌더링 제한이 있어서 길이를 넘기면 카드가 통째로 안 보인다.
빌더에서 잘라 넣는 이유.
"""

from typing import Any

MAX_CAROUSEL_ITEMS = 10
MAX_QUICK_REPLIES = 10
MAX_CARD_TITLE = 40
MAX_CARD_DESC = 76
MAX_BUTTON_LABEL = 14
MAX_QUICK_REPLY_LABEL = 14


def _cut(text: str | None, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def quick_reply(label: str, message_text: str | None = None) -> dict[str, Any]:
    return {
        "label": _cut(label, MAX_QUICK_REPLY_LABEL),
        "action": "message",
        "messageText": message_text or label,
    }


def quick_reply_block(label: str, block_id: str, extra: dict | None = None) -> dict[str, Any]:
    """다음 블록을 직접 호출하는 퀵리플라이. extra 는 다음 스킬의 clientExtra 로 전달된다."""
    item: dict[str, Any] = {
        "label": _cut(label, MAX_QUICK_REPLY_LABEL),
        "action": "block",
        "blockId": block_id,
    }
    if extra:
        item["extra"] = extra
    return item


def web_link_button(label: str, url: str) -> dict[str, Any]:
    return {
        "action": "webLink",
        "label": _cut(label, MAX_BUTTON_LABEL),
        "webLinkUrl": url,
    }


def basic_card(
    *,
    title: str,
    description: str = "",
    thumbnail_url: str | None = None,
    buttons: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    card: dict[str, Any] = {
        "title": _cut(title, MAX_CARD_TITLE),
        "description": _cut(description, MAX_CARD_DESC),
    }
    if thumbnail_url:
        card["thumbnail"] = {"imageUrl": thumbnail_url}
    if buttons:
        card["buttons"] = buttons[:3]
    return card


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


def carousel_of_cards(
    cards: list[dict[str, Any]],
    *,
    header_text: str | None = None,
    quick_replies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    outputs: list[dict[str, Any]] = []
    if header_text:
        outputs.append({"simpleText": {"text": header_text}})
    outputs.append(
        {"carousel": {"type": "basicCard", "items": cards[:MAX_CAROUSEL_ITEMS]}}
    )
    return skill_response(outputs, quick_replies)

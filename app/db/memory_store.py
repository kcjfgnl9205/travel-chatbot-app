"""no-op(DB 없음) 모드에서 리다이렉트를 살려두기 위한 인메모리 폴백.

Supabase 없이 로컬에서 챗봇을 띄워도 카드 클릭 → 애드픽 이동까지 돌아가게 한다.
프로세스가 죽으면 사라지므로 개발 전용. 운영에서는 항상 DB 경로를 탄다.
"""

from collections import OrderedDict
from typing import Any

_MAX_ENTRIES = 2000
_clicks: OrderedDict[str, dict[str, Any]] = OrderedDict()


def put(click_id: str, payload: dict[str, Any]) -> None:
    _clicks[click_id] = payload
    _clicks.move_to_end(click_id)
    while len(_clicks) > _MAX_ENTRIES:
        _clicks.popitem(last=False)


def get(click_id: str) -> dict[str, Any] | None:
    return _clicks.get(click_id)


def clear() -> None:
    _clicks.clear()

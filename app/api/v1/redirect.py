"""클릭 추적 리다이렉트.

카카오 카드 버튼이 가리키는 곳. 여기를 한 번 거쳐야
"어떤 사용자가 어떤 호텔을 눌렀는지"를 DB에 남길 수 있다.
사용자 체감이 나빠지지 않도록 로깅은 하되 실패해도 무조건 리다이렉트한다.
"""

import hashlib
import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.api.deps import DbDep, SettingsDep
from app.db import memory_store
from app.db.repositories import ClickRepository, RecommendationItemRepository

logger = logging.getLogger(__name__)

router = APIRouter(tags=["redirect"])

_EXPIRED_HTML = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>링크를 찾을 수 없어요</title></head>
<body style="font-family:-apple-system,sans-serif;padding:48px 24px;text-align:center">
<h2>링크가 만료되었어요</h2>
<p>챗봇에서 호텔을 다시 추천받아 주세요.</p>
</body></html>"""


def _hash_ip(ip: str | None) -> str | None:
    """원본 IP는 저장하지 않는다. 중복 클릭 판별용 해시만 남김."""
    if not ip:
        return None
    return hashlib.sha256(ip.encode()).hexdigest()[:32]


@router.get("/r/{click_id}")
async def redirect_click(
    click_id: str, request: Request, settings: SettingsDep, db: DbDep
):
    items = RecommendationItemRepository(db)
    clicks = ClickRepository(db)

    item = await items.find_by_click_id(click_id) or memory_store.get(click_id)
    if not item or not item.get("target_url"):
        logger.warning("unknown click_id=%s", click_id)
        return HTMLResponse(_EXPIRED_HTML, status_code=404)

    try:
        await clicks.log(
            click_id=click_id,
            recommendation_item_id=item.get("id"),
            recommendation_id=item.get("recommendation_id"),
            user_id=item.get("user_id"),
            hotel_id=item.get("hotel_id"),
            target_url=item["target_url"],
            user_agent=request.headers.get("user-agent"),
            referer=request.headers.get("referer"),
            ip_hash=_hash_ip(request.client.host if request.client else None),
        )
    except Exception:
        logger.exception("click log failed click_id=%s", click_id)

    logger.info("click click_id=%s hotel=%s", click_id, item.get("hotel_name"))
    return RedirectResponse(item["target_url"], status_code=302)

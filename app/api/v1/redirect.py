"""클릭 추적 리다이렉트.

카카오 listCard 의 줄 링크가 가리키는 곳. 여기를 한 번 거쳐야
"사용자가 어떤 호텔을 눌렀는지"를 DB에 남길 수 있다.

DB 왕복은 **한 번**이다. register_click() 함수가 조회·카운터 증가·목적지 반환을
동시에 한다. 사용자가 302 를 기다리는 경로라 왕복 수가 곧 체감 지연이다.
"""

import logging

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, RedirectResponse

from app.api.deps import DbDep, SettingsDep
from app.db import memory_store
from app.db.repositories import RecommendationItemRepository

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


@router.get("/r/{click_id}")
async def redirect_click(click_id: str, settings: SettingsDep, db: DbDep):
    items = RecommendationItemRepository(db)

    # DB 가 없거나 실패하면 인메모리 폴백으로 떨어진다 (로컬 개발용).
    item = await items.register_click(click_id) or memory_store.register_click(click_id)

    if not item or not item.get("target_url"):
        logger.warning("unknown click_id=%s", click_id)
        return HTMLResponse(_EXPIRED_HTML, status_code=404)

    logger.info(
        "click click_id=%s hotel=%s count=%s",
        click_id,
        item.get("hotel_name"),
        item.get("click_count"),
    )
    return RedirectResponse(item["target_url"], status_code=302)

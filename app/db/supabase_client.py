"""Supabase 접근 래퍼.

설계 원칙 2가지
1. **자격증명이 없으면 None 을 돌려주고 앱은 그대로 동작한다.** (no-op 모드)
   로컬에서 카카오 응답 JSON만 확인할 때 Supabase 없이 띄울 수 있어야 하므로.
2. **DB 오류가 챗봇 응답을 죽이면 안 된다.** 로깅은 부가 기능이지 본 기능이 아니다.
   그래서 repository 들은 실패 시 예외 대신 None 을 돌려준다.
"""

import asyncio
import logging
from typing import Any

from app.core.config import Settings

logger = logging.getLogger(__name__)

_client: Any | None = None
_client_loop: asyncio.AbstractEventLoop | None = None
_init_failed = False


async def get_client(settings: Settings) -> Any | None:
    """AsyncClient 싱글턴. 비활성/실패 시 None.

    클라이언트 내부의 커넥션 풀은 **만들어진 이벤트 루프에 묶인다.**
    운영(uvicorn)은 루프가 하나뿐이라 문제가 없지만, TestClient 는 요청마다
    새 루프를 만들기 때문에 캐시를 그대로 쓰면 "Event loop is closed" 가 난다.
    그래서 루프가 바뀌었으면 다시 만든다.
    """
    global _client, _client_loop, _init_failed

    if not settings.db_enabled or _init_failed:
        return None

    loop = asyncio.get_running_loop()
    if _client is not None and _client_loop is loop:
        return _client

    try:
        from supabase import acreate_client

        _client = await acreate_client(
            settings.supabase_url, settings.supabase_service_role_key
        )
        _client_loop = loop
        logger.info("supabase client ready")
    except Exception:
        _init_failed = True
        logger.exception("supabase client init failed; running without DB")
        return None
    return _client


def reset_client() -> None:
    """테스트용."""
    global _client, _client_loop, _init_failed
    _client = None
    _client_loop = None
    _init_failed = False

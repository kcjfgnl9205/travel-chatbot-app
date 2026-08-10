"""헬스체크.

두 개로 나눈 이유:

  /health     앱이 살아있나 (liveness). Caddy·compose 가 30초마다 두드린다.
              DB 를 건드리지 않는다 — DB 가 잠깐 흔들렸다고 컨테이너가 재시작되면 안 된다.

  /health/db  Supabase 자격증명이 **실제로 먹는가** (진단용).
              환경변수가 채워졌는지가 아니라 진짜 쿼리를 날려본다.
"""

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.api.deps import DbDep, SettingsDep

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops"])

# 0001_init.sql 이 만드는 테이블 전부. 하나라도 없으면 마이그레이션을 안 돌린 것.
EXPECTED_TABLES = (
    "users",
    "messages",
    "affiliate_links",
    "search_cache",
    "recommendations",
    "recommendation_items",
)


@router.get("/health")
async def health(settings: SettingsDep) -> dict:
    """앱 생존 확인. DB 는 건드리지 않는다."""
    return {
        "status": "ok",
        "env": settings.app_env,
        "db": "supabase" if settings.db_enabled else "disabled(no-op)",
        "provider": settings.hotel_provider,
        "adpick": "api" if settings.adpick_api_enabled else "fallback(no key)",
    }


@router.get("/health/db")
async def health_db(settings: SettingsDep, db: DbDep):
    """Supabase 에 실제로 붙는지, 테이블이 다 있는지 확인한다."""
    if not settings.db_enabled:
        return JSONResponse(
            status_code=503,
            content={
                "status": "disabled",
                "reason": "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 비어 있습니다.",
                "hint": ".env 를 확인하고 서버를 재시작하세요.",
            },
        )

    if db is None:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "reason": "Supabase 클라이언트 생성 실패",
                "hint": "SUPABASE_URL 형태가 https://{ref}.supabase.co 인지 확인하세요.",
            },
        )

    started = time.perf_counter()
    results = await asyncio.gather(
        *(_probe(db, name) for name in EXPECTED_TABLES)
    )
    latency_ms = int((time.perf_counter() - started) * 1000)

    tables = dict(results)
    missing = [name for name, ok in tables.items() if ok is not True]

    if missing:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "latency_ms": latency_ms,
                "tables": tables,
                "hint": _hint(tables),
            },
        )

    return {"status": "ok", "latency_ms": latency_ms, "tables": tables}


async def _probe(db: Any, table: str) -> tuple[str, Any]:
    """테이블 하나에 최소 쿼리를 날려본다. 성공하면 True, 실패하면 사유 문자열."""
    try:
        await db.table(table).select("*", head=True, count="exact").limit(1).execute()
    except Exception as exc:  # noqa: BLE001 — 사유를 그대로 보여주는 게 목적
        logger.warning("health/db probe failed table=%s err=%s", table, exc)
        return table, _short(exc)
    return table, True


def _short(exc: Exception) -> str:
    text = " ".join(str(exc).split())
    return text[:200] if text else exc.__class__.__name__


def _hint(tables: dict[str, Any]) -> str:
    """가장 흔한 원인 순으로 안내한다."""
    reasons = " ".join(str(v) for v in tables.values() if v is not True).lower()

    if all(v is not True for v in tables.values()):
        if "invalid" in reasons or "jwt" in reasons or "api key" in reasons:
            return (
                "키가 거부되었습니다. anon/publishable 이 아니라 "
                "Settings → API Keys 의 secret(sb_secret_...) 또는 "
                "Legacy 탭의 service_role 인지 확인하세요."
            )
        if "not exist" in reasons or "schema cache" in reasons or "404" in reasons:
            return "테이블이 없습니다. SQL Editor 에서 0001_init.sql 을 실행하세요."
        return "전 테이블 실패. URL·키·네트워크를 확인하세요."
    return "일부 테이블만 없습니다. 0001_init.sql 을 다시 실행하세요."

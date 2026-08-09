import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

QueryBuilder = Callable[[Any], Any]


class BaseRepository:
    """Supabase 테이블 하나에 대한 얇은 래퍼.

    쿼리는 `run(lambda q: ...)` 형태로 **지연 평가**한다.
    client 가 None(no-op 모드)일 때 람다를 아예 호출하지 않기 위해서다.

    그리고 모든 쿼리는 실패해도 예외를 올리지 않는다. 로깅 실패 때문에
    사용자가 호텔 목록을 못 받는 상황을 만들지 않기 위해서.
    """

    table_name: str = ""

    def __init__(self, client: Any | None) -> None:
        self.client = client

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def table(self, name: str | None = None) -> Any:
        return self.client.table(name or self.table_name)

    async def run(self, build: QueryBuilder, *, op: str = "query") -> list[dict] | None:
        if not self.enabled:
            return None
        try:
            response = await build(self.table()).execute()
        except Exception:
            logger.exception("supabase %s failed on %s", op, self.table_name)
            return None
        return list(getattr(response, "data", None) or [])

    async def run_one(self, build: QueryBuilder, *, op: str = "query") -> dict | None:
        rows = await self.run(build, op=op)
        return rows[0] if rows else None

    async def rpc(
        self, fn: str, params: dict[str, Any], *, op: str = "rpc"
    ) -> list[dict] | None:
        """Postgres 함수 호출.

        PostgREST 로는 `set x = x + 1` 같은 표현식 업데이트를 못 한다.
        원자적 증가가 필요하면 함수를 만들어 여기로 부른다.
        """
        if not self.enabled:
            return None
        try:
            response = await self.client.rpc(fn, params).execute()
        except Exception:  # noqa: BLE001
            logger.exception("supabase %s failed on %s", op, fn)
            return None
        return list(getattr(response, "data", None) or [])

from datetime import UTC, datetime, timedelta
from typing import Any

from app.db.repositories.base import BaseRepository


class SearchCacheRepository(BaseRepository):
    """검색 결과(호텔 목록) 캐시.

    AI/크롤링 provider 가 붙으면 이게 비용과 응답 속도를 동시에 좌우한다.
    """

    table_name = "search_cache"

    async def get(self, cache_key: str) -> dict | None:
        """만료되지 않은 캐시 행. 없으면 None."""
        row = await self.run_one(
            lambda q: q.select("id, payload, item_count, expires_at")
            .eq("cache_key", cache_key)
            .limit(1),
            op="select search cache",
        )
        if not row:
            return None
        if _expired(row.get("expires_at")):
            return None
        return row

    async def put(
        self,
        *,
        cache_key: str,
        domain: str,
        provider: str,
        payload: list[dict[str, Any]],
        ttl_minutes: int,
    ) -> None:
        record = {
            "cache_key": cache_key,
            "domain": domain,
            "provider": provider,
            "payload": payload,
            "item_count": len(payload),
            "hit_count": 0,
            "expires_at": (
                datetime.now(UTC) + timedelta(minutes=ttl_minutes)
            ).isoformat(),
        }
        await self.run(
            lambda q: q.upsert(record, on_conflict="cache_key"), op="upsert search cache"
        )

    async def mark_hit(self, cache_id: str, hit_count: int) -> None:
        """재사용 횟수. 아낀 provider 호출 수를 나중에 세기 위한 것."""
        await self.run(
            lambda q: q.update({"hit_count": hit_count + 1}).eq("id", cache_id),
            op="bump search cache hit",
        )


def _expired(expires_at: Any) -> bool:
    if not expires_at:
        return True
    try:
        return datetime.fromisoformat(str(expires_at)) <= datetime.now(UTC)
    except ValueError:
        return True

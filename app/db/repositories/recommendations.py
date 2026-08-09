from typing import Any

from app.db.repositories.base import BaseRepository


class RecommendationRepository(BaseRepository):
    table_name = "recommendations"

    async def create(
        self,
        *,
        user_id: str | None,
        message_id: str | None,
        domain: str,
        city_slug: str | None,
        provider: str,
        item_count: int,
        guests: int | None = None,
        latency_ms: int | None = None,
        cache_hit: bool = False,
    ) -> dict | None:
        record = {
            "user_id": user_id,
            "message_id": message_id,
            "domain": domain,
            "city_slug": city_slug,
            "provider": provider,
            "item_count": item_count,
            "guests": guests,
            "latency_ms": latency_ms,
            "cache_hit": cache_hit,
        }
        return await self.run_one(
            lambda q: q.insert(record), op="insert recommendation"
        )


class RecommendationItemRepository(BaseRepository):
    table_name = "recommendation_items"

    async def create_many(self, items: list[dict[str, Any]]) -> list[dict] | None:
        if not items:
            return []
        return await self.run(lambda q: q.insert(items), op="insert rec items")

    async def register_click(self, click_id: str) -> dict | None:
        """클릭 1회를 기록하고 리다이렉트 목적지를 돌려준다.

        조회 + 카운터 증가 + 목적지 반환을 DB 왕복 **한 번**에 처리한다.
        사용자가 302 를 기다리는 경로라 왕복 수가 곧 체감 지연이다.
        없는 click_id 면 빈 결과 → None.
        """
        rows = await self.rpc(
            "register_click", {"p_click_id": click_id}, op="register_click"
        )
        return rows[0] if rows else None

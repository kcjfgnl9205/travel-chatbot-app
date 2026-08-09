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
    ) -> dict | None:
        record = {
            "user_id": user_id,
            "message_id": message_id,
            "domain": domain,
            "city_slug": city_slug,
            "provider": provider,
            "item_count": item_count,
            "guests": guests,
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

    async def find_by_click_id(self, click_id: str) -> dict | None:
        return await self.run_one(
            lambda q: q.select(
                "id, recommendation_id, hotel_id, target_url, hotel_name"
            )
            .eq("click_id", click_id)
            .limit(1),
            op="select rec item",
        )

from app.db.repositories.base import BaseRepository


class ClickRepository(BaseRepository):
    table_name = "clicks"

    async def log(
        self,
        *,
        click_id: str,
        recommendation_item_id: str | None,
        recommendation_id: str | None,
        user_id: str | None,
        hotel_id: str | None,
        target_url: str | None,
        user_agent: str | None,
        referer: str | None,
        ip_hash: str | None,
    ) -> dict | None:
        record = {
            "click_id": click_id,
            "recommendation_item_id": recommendation_item_id,
            "recommendation_id": recommendation_id,
            "user_id": user_id,
            "hotel_id": hotel_id,
            "target_url": target_url,
            "user_agent": user_agent,
            "referer": referer,
            "ip_hash": ip_hash,
        }
        return await self.run_one(lambda q: q.insert(record), op="insert click")

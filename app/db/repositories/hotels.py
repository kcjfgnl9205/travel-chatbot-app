from typing import Any

from app.db.repositories.base import BaseRepository


class HotelRepository(BaseRepository):
    table_name = "hotels"

    async def id_map_by_external(self, external_ids: list[str]) -> dict[str, str]:
        """external_id → hotels.id 매핑. FK 를 채우기 위한 조회.

        DB 가 없거나 시드 전이면 빈 dict. 그래도 추천 응답은 정상 동작한다.
        """
        if not external_ids:
            return {}
        rows = await self.run(
            lambda q: q.select("id, external_id").in_("external_id", external_ids),
            op="select hotels",
        )
        return {r["external_id"]: r["id"] for r in (rows or []) if r.get("external_id")}

    async def upsert_many(self, hotels: list[dict[str, Any]]) -> list[dict] | None:
        return await self.run(
            lambda q: q.upsert(hotels, on_conflict="external_id"), op="upsert hotels"
        )


class HotelOfferRepository(BaseRepository):
    table_name = "hotel_offers"

    async def best_offer_map(self, hotel_ids: list[str]) -> dict[str, dict]:
        """hotel_id → 우선순위 가장 높은 활성 offer."""
        if not hotel_ids:
            return {}
        rows = await self.run(
            lambda q: q.select("id, hotel_id, target_url, priority")
            .in_("hotel_id", hotel_ids)
            .eq("is_active", True)
            .order("priority", desc=True),
            op="select offers",
        )
        best: dict[str, dict] = {}
        for row in rows or []:
            best.setdefault(row["hotel_id"], row)
        return best

    async def insert_many(self, offers: list[dict[str, Any]]) -> list[dict] | None:
        if not offers:
            return []
        return await self.run(lambda q: q.insert(offers), op="insert offers")

    async def deactivate_for_hotels(self, hotel_ids: list[str]) -> None:
        if not hotel_ids:
            return
        await self.run(
            lambda q: q.update({"is_active": False}).in_("hotel_id", hotel_ids),
            op="deactivate offers",
        )

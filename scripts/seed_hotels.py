"""data/hotels.json → Supabase (hotels, hotel_offers) 적재.

    python -m scripts.seed_hotels

여러 번 돌려도 hotels 는 external_id 로 upsert 된다.
hotel_offers 는 기존 활성 오퍼를 끄고 새로 넣는다.
"""

import asyncio
import json
import sys
from pathlib import Path

from app.core.config import get_settings
from app.db.repositories import HotelOfferRepository, HotelRepository
from app.db.supabase_client import get_client

DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "hotels.json"

HOTEL_COLUMNS = (
    "external_id",
    "name",
    "city_slug",
    "address",
    "star_rating",
    "review_score",
    "price_from",
    "thumbnail_url",
    "description",
    "tags",
)


async def main() -> int:
    settings = get_settings()
    client = await get_client(settings)
    if client is None:
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 를 .env 에 설정하세요.")
        return 1

    raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))["hotels"]
    hotels_repo = HotelRepository(client)
    offers_repo = HotelOfferRepository(client)

    payload = [{k: h.get(k) for k in HOTEL_COLUMNS} for h in raw]
    rows = await hotels_repo.upsert_many(payload)
    if rows is None:
        print("호텔 upsert 실패 (로그 확인)")
        return 1
    print(f"hotels upsert: {len(rows)}건")

    id_map = await hotels_repo.id_map_by_external([h["external_id"] for h in raw])
    offers = [
        {
            "hotel_id": id_map[h["external_id"]],
            "partner": "adpick",
            "target_url": h["target_url"],
            "priority": 100,
        }
        for h in raw
        if h.get("target_url") and h["external_id"] in id_map
    ]

    # 재실행 시 중복 방지: 기존 오퍼 비활성화 후 삽입
    await offers_repo.deactivate_for_hotels(list(id_map.values()))
    inserted = await offers_repo.insert_many(offers)
    print(f"hotel_offers insert: {len(inserted or [])}건")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

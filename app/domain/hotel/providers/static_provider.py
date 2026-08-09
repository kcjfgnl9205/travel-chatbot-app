import json
from functools import lru_cache
from pathlib import Path

from app.domain.hotel.providers.base import HotelProvider
from app.domain.hotel.schemas import Hotel, HotelQuery

DATA_PATH = Path(__file__).resolve().parents[4] / "data" / "hotels.json"


@lru_cache
def _load_hotels() -> list[Hotel]:
    raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return [Hotel(**item) for item in raw["hotels"]]


class StaticHotelProvider(HotelProvider):
    """Phase 1: data/hotels.json 고정 데이터."""

    name = "static"

    async def search(self, query: HotelQuery) -> list[Hotel]:
        hotels = [h for h in _load_hotels() if h.city_slug == query.city_slug]
        # 평점 높은 순 → 가격 낮은 순
        hotels.sort(key=lambda h: (-(h.review_score or 0), h.price_from or 10**9))
        return hotels[: query.limit]

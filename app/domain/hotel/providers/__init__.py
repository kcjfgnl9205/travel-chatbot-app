from app.core.config import Settings
from app.domain.hotel.providers.base import HotelProvider
from app.domain.hotel.providers.static_provider import StaticHotelProvider


def get_provider(settings: Settings) -> HotelProvider:
    # Phase 3에서 "ai" / "crawler" 분기를 여기에 추가한다.
    return StaticHotelProvider()


__all__ = ["HotelProvider", "StaticHotelProvider", "get_provider"]

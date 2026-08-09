from app.db.repositories.clicks import ClickRepository
from app.db.repositories.hotels import HotelOfferRepository, HotelRepository
from app.db.repositories.messages import MessageRepository
from app.db.repositories.recommendations import (
    RecommendationItemRepository,
    RecommendationRepository,
)
from app.db.repositories.users import UserRepository

__all__ = [
    "ClickRepository",
    "HotelOfferRepository",
    "HotelRepository",
    "MessageRepository",
    "RecommendationItemRepository",
    "RecommendationRepository",
    "UserRepository",
]

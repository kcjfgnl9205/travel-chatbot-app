from app.db.repositories.affiliate_links import AffiliateLinkRepository
from app.db.repositories.messages import MessageRepository
from app.db.repositories.recommendations import (
    RecommendationItemRepository,
    RecommendationRepository,
)
from app.db.repositories.search_cache import SearchCacheRepository
from app.db.repositories.users import UserRepository

__all__ = [
    "AffiliateLinkRepository",
    "MessageRepository",
    "RecommendationItemRepository",
    "RecommendationRepository",
    "SearchCacheRepository",
    "UserRepository",
]

"""검색 결과 캐시.

"오사카 호텔 추천해줘"를 다음 사람이 물으면 provider 를 다시 부르지 않고
저장해둔 호텔 목록을 그대로 준다.

AI/크롤링 provider 가 붙으면 이게 두 가지를 동시에 해결한다.
  · 속도 — LLM 호출 3~10초는 카카오 5초 제한을 넘긴다. 캐시 히트는 수십 ms
  · 비용 — 같은 도시를 100명이 물어도 provider 호출은 1회

캐시에 담는 건 **provider 가 돌려준 호텔 목록**이지 완성된 카드가 아니다.
click_id 는 노출마다 새로 발급돼야 하므로 캐시 밖(service)에서 만든다.
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from app.core.config import Settings
from app.db.repositories import SearchCacheRepository
from app.domain.hotel.schemas import Hotel, HotelQuery

logger = logging.getLogger(__name__)


def build_cache_key(domain: str, provider: str, query: HotelQuery) -> str:
    """캐시 키.

    지금은 'hotel:static:osaka::5'. 날짜/인원 파싱이 붙으면 값을 이어 붙이면 된다
    (cache_key 는 text 라 스키마 변경이 필요 없다).
    provider 를 키에 넣는 이유: static → ai 로 바꿨을 때 옛 결과가 나오면 안 된다.
    """
    parts = [
        domain,
        provider,
        query.city_slug,
        str(query.guests or ""),
        str(query.check_in or ""),
        str(query.check_out or ""),
        str(query.limit),
    ]
    return ":".join(parts)


class SearchCache:
    def __init__(self, settings: Settings, db: Any | None) -> None:
        self.settings = settings
        self.repo = SearchCacheRepository(db)

    @property
    def enabled(self) -> bool:
        return self.settings.search_cache_ttl_minutes > 0 and self.repo.enabled

    async def get_or_call(
        self,
        *,
        domain: str,
        provider: str,
        query: HotelQuery,
        call: Callable[[], Awaitable[list[Hotel]]],
    ) -> tuple[list[Hotel], bool]:
        """캐시에 있으면 그걸, 없으면 provider 를 부르고 저장한다.

        반환값의 두 번째는 캐시 히트 여부 (recommendations.cache_hit 에 기록).
        """
        if not self.enabled:
            return await call(), False

        cache_key = build_cache_key(domain, provider, query)
        cached = await self.repo.get(cache_key)

        if cached and cached.get("payload"):
            hotels = _revive(cached["payload"])
            if hotels:
                logger.info("search cache hit key=%s items=%d", cache_key, len(hotels))
                await self.repo.mark_hit(cached["id"], cached.get("hit_count", 0))
                return hotels, True

        hotels = await call()
        # 빈 결과는 캐싱하지 않는다. 일시적 실패를 TTL 동안 굳혀버리면 안 된다.
        if hotels:
            await self.repo.put(
                cache_key=cache_key,
                domain=domain,
                provider=provider,
                payload=[h.model_dump(mode="json") for h in hotels],
                ttl_minutes=self.settings.search_cache_ttl_minutes,
            )
        return hotels, False


def _revive(payload: Any) -> list[Hotel]:
    """캐시에 저장된 dict 목록을 Hotel 로 되돌린다.

    저장 당시와 Hotel 필드가 달라졌을 수 있으므로(배포 직후) 깨지면 미스로 처리한다.
    """
    if not isinstance(payload, list):
        return []
    try:
        return [Hotel(**item) for item in payload]
    except Exception:  # noqa: BLE001
        logger.warning("search cache payload incompatible; treating as miss")
        return []

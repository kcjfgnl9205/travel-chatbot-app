"""호텔 추천 유스케이스.

엔드포인트는 얇게 두고 흐름은 전부 여기 모은다.

  발화 파싱 → 사용자/메시지 로깅
    → provider 검색 (AI/크롤링/고정) : 호텔 + 원본 주소(아고다 등)
    → 발견한 호텔 upsert (hotels)
    → 원본 주소 → 애드픽 제휴 주소 변환 (캐시 우선)
    → 추천 저장 (+click_id 발급)
    → 카카오 캐러셀 조립

사용자에게 노출되는 건 우리 리다이렉트(`/r/{click_id}`)뿐이고,
그 302 목적지가 애드픽 제휴 주소다. 원본 주소는 DB에만 남는다.
"""

import logging
import secrets
import time
from typing import Any

from app.core.config import Settings
from app.db import memory_store
from app.db.repositories import (
    MessageRepository,
    RecommendationItemRepository,
    RecommendationRepository,
    UserRepository,
)
from app.domain.hotel.providers import get_provider
from app.domain.hotel.schemas import Hotel, HotelQuery
from app.kakao import templates as t
from app.kakao.schemas import KakaoSkillPayload
from app.services import nlu
from app.services.adpick import apply_subid
from app.services.affiliate import AffiliateResolver
from app.services.search_cache import SearchCache

logger = logging.getLogger(__name__)

DOMAIN = "hotel"


def _new_click_id() -> str:
    return secrets.token_urlsafe(9)


def _dedupe(hotels: list[Hotel]) -> list[Hotel]:
    """같은 호텔이 리스트에 두 번 나가지 않게 한다.

    AI provider 는 같은 호텔을 이름만 다르게 여러 번 주기도 한다
    ('호텔 그란비아 오사카' / 'Hotel Granvia Osaka').
    이름은 못 믿으므로 source_url(호텔 신원)로 판정한다.

    `recommendation_items` 여러 행이 같은 `affiliate_links` 행을 가리키는 건
    정상이지만(다른 사용자·다른 시점의 노출), **한 리스트 안에서 중복되면**
    사용자에게 같은 호텔이 두 줄로 보인다.
    """
    seen: set[str] = set()
    unique: list[Hotel] = []
    for hotel in hotels:
        key = hotel.source_url or hotel.name
        if key in seen:
            logger.info("duplicate hotel dropped: %s (%s)", hotel.name, key)
            continue
        seen.add(key)
        unique.append(hotel)
    return unique


class HotelRecommendService:
    def __init__(self, settings: Settings, client: Any | None) -> None:
        self.settings = settings
        self.provider = get_provider(settings)
        self.users = UserRepository(client)
        self.messages = MessageRepository(client)
        self.recommendations = RecommendationRepository(client)
        self.items = RecommendationItemRepository(client)
        self.affiliate = AffiliateResolver(settings, client)
        self.search_cache = SearchCache(settings, client)

    # ------------------------------------------------------------ 진입점
    async def handle(self, payload: KakaoSkillPayload) -> dict:
        started = time.perf_counter()
        parsed = nlu.parse(
            payload.utterance, payload.param("city", "location", "sys_location")
        )

        user = await self.users.get_or_create(payload.user_key)
        user_id = user.get("id") if user else None

        message = await self.messages.log(
            user_id=user_id,
            domain=DOMAIN,
            utterance=payload.utterance,
            block_name=payload.block_name,
            parsed_city=parsed.city_slug,
            params=payload.action.params,
            raw_payload=payload.model_dump(mode="json"),
        )
        message_id = message.get("id") if message else None

        if not parsed.has_city:
            return self._ask_city()

        query = HotelQuery(
            city_slug=parsed.city_slug or "",
            city_name=parsed.city_name or "",
            guests=parsed.guests,
            limit=self.settings.hotel_result_limit,
        )
        # 캐시에 있으면 provider 를 안 부른다.
        # AI/크롤링이 붙으면 이 한 줄이 5초 예산과 호출 비용을 좌우한다.
        hotels, cache_hit = await self.search_cache.get_or_call(
            domain=DOMAIN,
            provider=self.provider.name,
            query=query,
            call=lambda: self.provider.search(query),
        )
        if not hotels:
            return self._no_result(query.city_name)

        return await self._respond_with_hotels(
            hotels,
            query,
            user_id=user_id,
            message_id=message_id,
            guests=parsed.guests,
            started=started,
            cache_hit=cache_hit,
        )

    # ------------------------------------------------------- 응답 조립
    async def _respond_with_hotels(
        self,
        hotels: list[Hotel],
        query: HotelQuery,
        *,
        user_id: str | None,
        message_id: str | None,
        guests: int | None,
        started: float,
        cache_hit: bool = False,
    ) -> dict:
        # 중복 제거 → 자르기 순서가 중요하다. 반대로 하면 중복이 5줄 자리를 먹는다.
        # listCard 는 최대 5줄이고, 자르기 전에 애드픽 변환을 돌리면
        # 보여주지도 못할 호텔 때문에 rate limit 을 헛되이 쓴다.
        hotels = _dedupe(hotels)[: t.MAX_LIST_ITEMS]

        # 원본 주소 → 애드픽 제휴 주소. 캐시에 있으면 API 를 안 탄다.
        # affiliate_links 행이 곧 호텔의 신원이기도 하다 — 별도 호텔 마스터를 두지 않는다.
        links = await self.affiliate.resolve(
            [(h.source_url, h.merchant) for h in hotels if h.source_url]
        )

        recommendation = await self.recommendations.create(
            user_id=user_id,
            message_id=message_id,
            domain=DOMAIN,
            city_slug=query.city_slug,
            provider=self.provider.name,
            item_count=len(hotels),
            guests=guests,
            latency_ms=int((time.perf_counter() - started) * 1000),
            cache_hit=cache_hit,
        )
        recommendation_id = recommendation.get("id") if recommendation else None

        rows: list[dict] = []
        list_items: list[dict] = []

        for position, hotel in enumerate(hotels):
            click_id = _new_click_id()
            link = links.get(hotel.source_url)
            # 변환이 실패해도 원본 주소로 보낸다. 수익화는 못 해도 사용자는 호텔을 본다.
            destination = link.affiliate_url if link else hotel.source_url
            if not destination:
                logger.warning("no destination for hotel=%s, skipping card", hotel.name)
                continue
            target_url = apply_subid(destination, click_id, self.settings)

            rows.append(
                {
                    "recommendation_id": recommendation_id,
                    "affiliate_link_id": link.affiliate_link_id if link else None,
                    "position": position,
                    "click_id": click_id,
                    "hotel_name": hotel.name,
                    "price_from": hotel.price_from,
                    "merchant": hotel.merchant,
                    "thumbnail_url": hotel.thumbnail_url,
                    "source_url": hotel.source_url,
                    "target_url": target_url,
                }
            )
            # DB가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
            memory_store.put(
                click_id,
                {
                    "recommendation_id": recommendation_id,
                    "hotel_name": hotel.name,
                    "source_url": hotel.source_url,
                    "target_url": target_url,
                    "user_id": user_id,
                },
            )
            # 줄 전체가 링크가 된다. 링크는 애드픽이 아니라 우리 리다이렉트를 가리킨다.
            list_items.append(
                t.list_item(
                    title=hotel.name,
                    description=hotel.list_description(),
                    image_url=hotel.thumbnail_url,
                    link_url=self.settings.redirect_url(click_id),
                )
            )

        if not list_items:
            return self._no_result(query.city_name)

        if recommendation_id:
            await self.items.create_many(rows)

        return t.list_card(
            header_title=f"{query.city_name} 호텔 추천 {len(list_items)}곳",
            items=list_items,
            buttons=[t.message_button("다른 도시 보기", "호텔 추천해줘")],
            quick_replies=self._city_quick_replies(exclude=query.city_slug),
        )

    # ------------------------------------------------------- 예외 응답
    def _ask_city(self) -> dict:
        return t.simple_text(
            "어느 도시 호텔을 찾으세요?\n예) 오사카 호텔 추천해줘",
            quick_replies=self._city_quick_replies(),
        )

    def _no_result(self, city_name: str) -> dict:
        return t.simple_text(
            f"{city_name} 호텔은 아직 준비 중이에요. 다른 도시를 골라주세요!",
            quick_replies=self._city_quick_replies(),
        )

    @staticmethod
    def _city_quick_replies(exclude: str | None = None) -> list[dict]:
        return [
            t.quick_reply(f"{city['name_ko']} 호텔", f"{city['name_ko']} 호텔 추천해줘")
            for city in nlu.CITIES
            if city["slug"] != exclude
        ]

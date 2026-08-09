"""호텔 추천 유스케이스.

엔드포인트는 얇게 두고 흐름은 전부 여기 모은다.
  발화 파싱 → 사용자/메시지 로깅 → provider 검색 → 추천 저장(+click_id 발급)
  → 카카오 캐러셀 조립
"""

import logging
import secrets
from typing import Any

from app.core.config import Settings
from app.db import memory_store
from app.db.repositories import (
    HotelOfferRepository,
    HotelRepository,
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
from app.services.adpick import build_target_url

logger = logging.getLogger(__name__)

DOMAIN = "hotel"


def _new_click_id() -> str:
    return secrets.token_urlsafe(9)


class HotelRecommendService:
    def __init__(self, settings: Settings, client: Any | None) -> None:
        self.settings = settings
        self.provider = get_provider(settings)
        self.users = UserRepository(client)
        self.messages = MessageRepository(client)
        self.hotels = HotelRepository(client)
        self.offers = HotelOfferRepository(client)
        self.recommendations = RecommendationRepository(client)
        self.items = RecommendationItemRepository(client)

    # ------------------------------------------------------------ 진입점
    async def handle(self, payload: KakaoSkillPayload) -> dict:
        parsed = nlu.parse(payload.utterance, payload.param("city", "location", "sys_location"))

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
        hotels = await self.provider.search(query)
        if not hotels:
            return self._no_result(query.city_name)

        return await self._respond_with_hotels(
            hotels, query, user_id=user_id, message_id=message_id, guests=parsed.guests
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
    ) -> dict:
        recommendation = await self.recommendations.create(
            user_id=user_id,
            message_id=message_id,
            domain=DOMAIN,
            city_slug=query.city_slug,
            provider=self.provider.name,
            item_count=len(hotels),
            guests=guests,
        )
        recommendation_id = recommendation.get("id") if recommendation else None

        # DB에 시드된 호텔이면 FK를 채운다. 없으면 None으로 두고 그대로 진행.
        hotel_id_map = await self.hotels.id_map_by_external([h.external_id for h in hotels])
        offer_map = await self.offers.best_offer_map(list(hotel_id_map.values()))

        rows: list[dict] = []
        cards: list[dict] = []

        for position, hotel in enumerate(hotels):
            click_id = _new_click_id()
            hotel_id = hotel_id_map.get(hotel.external_id)
            offer = offer_map.get(hotel_id) if hotel_id else None
            base_url = (offer or {}).get("target_url") or hotel.target_url
            target_url = build_target_url(base_url, click_id, self.settings)

            rows.append(
                {
                    "recommendation_id": recommendation_id,
                    "hotel_id": hotel_id,
                    "hotel_offer_id": (offer or {}).get("id"),
                    "position": position,
                    "click_id": click_id,
                    "hotel_name": hotel.name,
                    "price_from": hotel.price_from,
                    "target_url": target_url,
                }
            )
            # DB가 없어도 리다이렉트가 동작하도록 인메모리에도 남긴다.
            memory_store.put(
                click_id,
                {
                    "recommendation_id": recommendation_id,
                    "hotel_id": hotel_id,
                    "hotel_name": hotel.name,
                    "target_url": target_url,
                    "user_id": user_id,
                },
            )
            cards.append(
                t.basic_card(
                    title=hotel.name,
                    description=hotel.card_description(),
                    thumbnail_url=hotel.thumbnail_url,
                    buttons=[
                        t.web_link_button(
                            "예약하러 가기", self.settings.redirect_url(click_id)
                        )
                    ],
                )
            )

        if recommendation_id:
            await self.items.create_many(rows)

        return t.carousel_of_cards(
            cards,
            header_text=f"{query.city_name} 호텔 {len(cards)}곳 골라봤어요 👇",
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

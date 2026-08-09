from datetime import date
from typing import Any

from pydantic import BaseModel, Field


class HotelQuery(BaseModel):
    city_slug: str
    city_name: str = ""
    check_in: date | None = None
    check_out: date | None = None
    guests: int | None = None
    limit: int = 5


class Hotel(BaseModel):
    """provider 가 돌려주는 호텔 1건. 어떤 provider(AI/크롤링/고정)든 이 형태로 맞춘다."""

    name: str
    city_slug: str
    # AI/크롤링이 찾아낸 원본 호텔 주소(아고다/부킹 등).
    # 이 주소를 애드픽 API 로 변환해서 사용자에게 보여준다.
    source_url: str = ""
    merchant: str | None = None            # agoda | booking | ...
    source: str = "manual"                 # ai | crawler | manual
    source_ref: str | None = None          # 원본 소스의 ID (있으면)
    raw: dict[str, Any] | None = None      # provider 원본 응답

    address: str | None = None
    star_rating: float | None = None
    review_score: float | None = None
    price_from: int | None = None
    currency: str = "KRW"
    thumbnail_url: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)

    def price_text(self) -> str:
        if not self.price_from:
            return "가격 문의"
        return f"1박 {self.price_from:,}원~"

    def list_description(self) -> str:
        """listCard 한 줄 설명. 1줄이라 가격·평점·지역만 압축해서 넣는다.

        AI/크롤링 결과는 필드가 비어 올 수 있으므로 있는 것만 이어 붙인다.
        """
        bits: list[str] = [self.price_text()]
        if self.review_score:
            bits.append(f"평점 {self.review_score}")
        if self.tags:
            bits.append(self.tags[0])
        return " · ".join(bits)

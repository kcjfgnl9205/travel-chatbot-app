from datetime import date

from pydantic import BaseModel, Field


class HotelQuery(BaseModel):
    city_slug: str
    city_name: str = ""
    check_in: date | None = None
    check_out: date | None = None
    guests: int | None = None
    limit: int = 5


class Hotel(BaseModel):
    """provider 가 돌려주는 호텔 1건. 어떤 provider든 이 형태로 맞춘다."""

    external_id: str
    name: str
    city_slug: str
    address: str | None = None
    star_rating: float | None = None
    review_score: float | None = None
    price_from: int | None = None
    currency: str = "KRW"
    thumbnail_url: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    # 애드픽 딥링크 원본 (click_id 를 붙이기 전)
    target_url: str = ""

    def price_text(self) -> str:
        if not self.price_from:
            return "가격 문의"
        return f"1박 {self.price_from:,}원~"

    def card_description(self) -> str:
        bits: list[str] = [self.price_text()]
        if self.review_score:
            bits.append(f"평점 {self.review_score}")
        line1 = " · ".join(bits)
        if self.description:
            return f"{line1}\n{self.description}"
        return line1

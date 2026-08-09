from app.domain.hotel.schemas import Hotel


def test_list_description_uses_available_fields():
    full = Hotel(
        name="테스트 호텔",
        city_slug="osaka",
        price_from=120000,
        review_score=8.8,
        tags=["우메다", "가성비"],
    )
    assert full.list_description() == "1박 120,000원~ · 평점 8.8 · 우메다"


def test_list_description_without_price_or_score():
    """AI/크롤링 결과는 필드가 비어 올 수 있다."""
    sparse = Hotel(name="테스트 호텔", city_slug="osaka")
    assert sparse.list_description() == "가격 문의"


def test_dedupe_drops_same_hotel_with_different_names():
    """AI 는 같은 호텔을 이름만 다르게 여러 번 주기도 한다."""
    from app.domain.hotel.service import _dedupe

    hotels = [
        Hotel(name="호텔 그란비아 오사카", city_slug="osaka", source_url="https://a/1"),
        Hotel(name="Hotel Granvia Osaka", city_slug="osaka", source_url="https://a/1"),
        Hotel(name="크로스 호텔 오사카", city_slug="osaka", source_url="https://a/2"),
    ]
    result = _dedupe(hotels)

    assert [h.source_url for h in result] == ["https://a/1", "https://a/2"]
    assert result[0].name == "호텔 그란비아 오사카"  # 먼저 온 쪽을 남긴다


def test_dedupe_falls_back_to_name_without_source_url():
    from app.domain.hotel.service import _dedupe

    hotels = [
        Hotel(name="같은 호텔", city_slug="osaka"),
        Hotel(name="같은 호텔", city_slug="osaka"),
        Hotel(name="다른 호텔", city_slug="osaka"),
    ]
    assert len(_dedupe(hotels)) == 2


def test_source_url_is_the_hotel_identity():
    """호텔 마스터 테이블이 없으므로 source_url 이 유일한 신원이다.

    이름은 AI 가 매번 다르게 준다('그란비아 오사카' / 'Hotel Granvia Osaka').
    그래서 집계는 이름이 아니라 source_url / affiliate_link_id 로 한다.
    """
    same_hotel_a = Hotel(
        name="호텔 그란비아 오사카", city_slug="osaka", source_url="https://a.test/1"
    )
    same_hotel_b = Hotel(
        name="Hotel Granvia Osaka", city_slug="osaka", source_url="https://a.test/1"
    )
    assert same_hotel_a.name != same_hotel_b.name
    assert same_hotel_a.source_url == same_hotel_b.source_url

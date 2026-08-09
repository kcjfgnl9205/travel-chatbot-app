import pytest

from app.core.config import Settings
from app.services import nlu
from app.services.adpick import build_target_url


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("오사카 호텔 추천해줘", "osaka"),
        ("도쿄 숙소 알려줘", "tokyo"),
        ("동경 호텔", "tokyo"),
        ("fukuoka hotel", "fukuoka"),
        ("大阪 호텔", "osaka"),
        ("호텔 추천", None),
    ],
)
def test_city_parsing(text, expected):
    assert nlu.parse(text).city_slug == expected


def test_guests_and_nights():
    parsed = nlu.parse("오사카 2박 3명 호텔")
    assert (parsed.guests, parsed.nights) == (3, 2)


def test_adpick_subid_appended():
    settings = Settings(adpick_subid_param="subid")
    url = build_target_url("https://ad.pick/abc?utm=kakao", "CLICK123", settings)
    assert "subid=CLICK123" in url
    assert "utm=kakao" in url


def test_adpick_keeps_existing_subid():
    settings = Settings(adpick_subid_param="subid")
    url = build_target_url("https://ad.pick/abc?subid=fixed", "CLICK123", settings)
    assert "subid=fixed" in url
    assert "CLICK123" not in url

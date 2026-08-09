import pytest

from app.services import nlu


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

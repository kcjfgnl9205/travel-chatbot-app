"""아주 얇은 발화 파싱.

오픈빌더 엔티티가 city 를 뽑아주면 그걸 쓰고, 없으면 여기서 폴백 처리한다.
Phase 3에서 LLM 파서로 교체할 자리.
"""

import re
from dataclasses import dataclass

# 도시 마스터. supabase `cities` 테이블과 동일한 내용을 코드에도 둬서
# DB 없이도(no-op 모드) 챗봇이 동작하게 한다.
CITIES: list[dict] = [
    {
        "slug": "osaka",
        "name_ko": "오사카",
        "country_ko": "일본",
        "aliases": ["오사카", "오오사카", "osaka", "大阪"],
    },
    {
        "slug": "tokyo",
        "name_ko": "도쿄",
        "country_ko": "일본",
        "aliases": ["도쿄", "동경", "tokyo", "東京"],
    },
    {
        "slug": "fukuoka",
        "name_ko": "후쿠오카",
        "country_ko": "일본",
        "aliases": ["후쿠오카", "후쿠", "fukuoka", "福岡"],
    },
]

CITY_BY_SLUG = {c["slug"]: c for c in CITIES}

_GUESTS_RE = re.compile(r"(\d+)\s*(?:명|인)")
_NIGHTS_RE = re.compile(r"(\d+)\s*박")


@dataclass(slots=True)
class ParsedQuery:
    city_slug: str | None = None
    city_name: str | None = None
    guests: int | None = None
    nights: int | None = None

    @property
    def has_city(self) -> bool:
        return self.city_slug is not None


def match_city(text: str | None) -> dict | None:
    """텍스트에서 도시 하나를 찾는다. 가장 먼저 등장하는 도시를 채택."""
    if not text:
        return None
    lowered = text.lower()
    best: tuple[int, dict] | None = None
    for city in CITIES:
        for alias in city["aliases"]:
            idx = lowered.find(alias.lower())
            if idx >= 0 and (best is None or idx < best[0]):
                best = (idx, city)
    return best[1] if best else None


def parse(utterance: str, city_param: str | None = None) -> ParsedQuery:
    """엔티티 파라미터 우선, 없으면 발화 텍스트에서 폴백 파싱."""
    city = match_city(city_param) or match_city(utterance)
    guests_m = _GUESTS_RE.search(utterance or "")
    nights_m = _NIGHTS_RE.search(utterance or "")
    return ParsedQuery(
        city_slug=city["slug"] if city else None,
        city_name=city["name_ko"] if city else None,
        guests=int(guests_m.group(1)) if guests_m else None,
        nights=int(nights_m.group(1)) if nights_m else None,
    )


def supported_city_names() -> list[str]:
    return [c["name_ko"] for c in CITIES]

"""검색 결과 캐시.

Supabase 없이 검증하기 위해 SearchCacheRepository 를 인메모리로 대체한다.
(repo 계약: get() → 행 또는 None, put() → 저장, mark_hit() → 재사용 카운트)
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.core.config import Settings
from app.domain.hotel.schemas import Hotel, HotelQuery
from app.services.search_cache import SearchCache, build_cache_key

QUERY = HotelQuery(city_slug="osaka", city_name="오사카", limit=5)
HOTELS = [
    Hotel(name="호텔 A", city_slug="osaka", price_from=100000, source_url="https://a/1"),
    Hotel(name="호텔 B", city_slug="osaka", price_from=120000, source_url="https://a/2"),
]


class FakeRepo:
    """인메모리 캐시 저장소. 실제 repo 와 같은 계약."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.rows: dict[str, dict] = {}
        self.hits: list[str] = []

    async def get(self, cache_key):
        row = self.rows.get(cache_key)
        if row and datetime.fromisoformat(row["expires_at"]) <= datetime.now(UTC):
            return None
        return row

    async def put(self, *, cache_key, domain, provider, payload, ttl_minutes):
        self.rows[cache_key] = {
            "id": cache_key,
            "payload": payload,
            "item_count": len(payload),
            "hit_count": 0,
            "expires_at": (
                datetime.now(UTC) + timedelta(minutes=ttl_minutes)
            ).isoformat(),
        }

    async def mark_hit(self, cache_id, hit_count):
        self.hits.append(cache_id)


def _cache(repo, ttl_minutes: int = 60) -> SearchCache:
    cache = SearchCache(Settings(search_cache_ttl_minutes=ttl_minutes), None)
    cache.repo = repo
    return cache


class Counter:
    """provider 가 실제로 몇 번 불렸는지 센다."""

    def __init__(self, result=HOTELS) -> None:
        self.calls = 0
        self.result = result

    async def __call__(self):
        self.calls += 1
        return self.result


# ------------------------------------------------------------------ 캐시 키
def test_cache_key_includes_provider_and_query():
    key = build_cache_key("hotel", "ai", QUERY)
    assert key.startswith("hotel:ai:osaka")
    # provider 가 다르면 키도 달라야 한다 (static → ai 전환 시 옛 결과 금지)
    assert build_cache_key("hotel", "static", QUERY) != key


def test_cache_key_separates_guests():
    a = build_cache_key("hotel", "ai", HotelQuery(city_slug="osaka", guests=2))
    b = build_cache_key("hotel", "ai", HotelQuery(city_slug="osaka", guests=4))
    assert a != b


# ------------------------------------------------------------- 히트 / 미스
async def test_second_call_hits_cache_and_skips_provider():
    repo, call = FakeRepo(), Counter()
    cache = _cache(repo)

    first, hit1 = await cache.get_or_call(
        domain="hotel", provider="ai", query=QUERY, call=call
    )
    second, hit2 = await cache.get_or_call(
        domain="hotel", provider="ai", query=QUERY, call=call
    )

    assert call.calls == 1  # ← provider 는 한 번만. 이게 LLM 비용 절감의 핵심
    assert (hit1, hit2) == (False, True)
    assert [h.name for h in first] == [h.name for h in second]
    assert repo.hits == [build_cache_key("hotel", "ai", QUERY)]


async def test_different_city_is_a_separate_entry():
    repo, call = FakeRepo(), Counter()
    cache = _cache(repo)

    await cache.get_or_call(domain="hotel", provider="ai", query=QUERY, call=call)
    await cache.get_or_call(
        domain="hotel", provider="ai", query=HotelQuery(city_slug="tokyo"), call=call
    )
    assert call.calls == 2


async def test_expired_entry_refetches():
    repo, call = FakeRepo(), Counter()
    cache = _cache(repo, ttl_minutes=60)
    await cache.get_or_call(domain="hotel", provider="ai", query=QUERY, call=call)

    # 만료시킨다
    key = build_cache_key("hotel", "ai", QUERY)
    repo.rows[key]["expires_at"] = (
        datetime.now(UTC) - timedelta(minutes=1)
    ).isoformat()

    _, hit = await cache.get_or_call(
        domain="hotel", provider="ai", query=QUERY, call=call
    )
    assert call.calls == 2
    assert hit is False


async def test_empty_result_is_not_cached():
    """일시적 실패를 TTL 동안 굳혀버리면 안 된다."""
    repo, call = FakeRepo(), Counter(result=[])
    cache = _cache(repo)

    await cache.get_or_call(domain="hotel", provider="ai", query=QUERY, call=call)
    await cache.get_or_call(domain="hotel", provider="ai", query=QUERY, call=call)
    assert call.calls == 2
    assert repo.rows == {}


async def test_incompatible_payload_falls_back_to_provider():
    """배포로 Hotel 필드가 바뀌어도 캐시 때문에 죽으면 안 된다."""
    repo, call = FakeRepo(), Counter()
    cache = _cache(repo)
    key = build_cache_key("hotel", "ai", QUERY)
    repo.rows[key] = {
        "id": key,
        "payload": [{"완전히": "다른모양"}],
        "hit_count": 0,
        "expires_at": (datetime.now(UTC) + timedelta(minutes=60)).isoformat(),
    }

    hotels, hit = await cache.get_or_call(
        domain="hotel", provider="ai", query=QUERY, call=call
    )
    assert call.calls == 1
    assert hit is False
    assert len(hotels) == 2


# ------------------------------------------------------------------ 비활성
@pytest.mark.parametrize(
    ("ttl", "repo_enabled"),
    [(0, True), (60, False)],  # TTL 0 = 끔 / DB 없음(no-op 모드)
)
async def test_disabled_cache_always_calls_provider(ttl, repo_enabled):
    repo, call = FakeRepo(enabled=repo_enabled), Counter()
    cache = _cache(repo, ttl_minutes=ttl)

    for _ in range(2):
        _, hit = await cache.get_or_call(
            domain="hotel", provider="ai", query=QUERY, call=call
        )
        assert hit is False
    assert call.calls == 2

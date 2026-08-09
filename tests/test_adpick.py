import pytest

from app.core.config import Settings
from app.services.adpick import (
    P_DATA_MAX,
    STATUS_FALLBACK,
    STATUS_OK,
    AdpickClient,
    apply_subid,
    p_data_for,
    render_template,
)

SOURCE = "https://www.agoda.com/ko-kr/hotel/12345.html?cid=1"
API_KEY = "TESTKEY123"


def _api_settings(**kw) -> Settings:
    return Settings(adpick_api_key=API_KEY, adpick_link_template="", **kw)


class _Response:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _fake_client(capture: dict, body=None, boom: Exception | None = None):
    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None, **kw):
            capture["url"] = url
            capture["params"] = params
            if boom:
                raise boom
            return _Response(body)

    return _Client


# ------------------------------------------------------------------ 순수 함수
def test_p_data_is_stable_and_within_spec():
    first = p_data_for(SOURCE)
    assert first == p_data_for(SOURCE)          # 같은 주소 → 같은 코드 (링크 재사용)
    assert p_data_for(SOURCE) != p_data_for(SOURCE + "x")
    assert len(first) <= P_DATA_MAX             # 애드픽 스펙: string(50)


def test_render_template_encodes_source_url():
    url = render_template(
        "https://adpick.test/c/AB12?url={source_url}&subid={click_id}", SOURCE, "CLICK1"
    )
    assert "url=https%3A%2F%2Fwww.agoda.com%2Fko-kr%2Fhotel%2F12345.html%3Fcid%3D1" in url
    assert "subid=CLICK1" in url


def test_apply_subid_disabled_by_default():
    """애드픽 커미션 링크는 임의 파라미터를 해석하지 않는다. 기본값은 비활성."""
    url = apply_subid("https://link.adpick.co.kr/abc", "CLICK1", Settings())
    assert url == "https://link.adpick.co.kr/abc"


def test_apply_subid_when_explicitly_enabled():
    settings = Settings(adpick_subid_param="subid")
    url = apply_subid("https://other.test/c?utm=kakao", "CLICK1", settings)
    assert "subid=CLICK1" in url and "utm=kakao" in url


# ------------------------------------------------------------------ API 호출
async def test_convert_calls_documented_endpoint(monkeypatch):
    capture: dict = {}
    body = {
        "success": True,
        "message": "커미션 링크 생성 성공",
        "data": {
            "status": "success",
            "commissionlink": "https://link.adpick.co.kr/xxxxxxxx",
        },
    }
    monkeypatch.setattr(
        "app.services.adpick.httpx.AsyncClient", _fake_client(capture, body)
    )

    result = await AdpickClient(_api_settings()).convert(SOURCE, merchant="agoda")

    # GET https://biz.adpick.co.kr/api/{apikey}/link?url=...
    assert capture["url"] == f"https://biz.adpick.co.kr/api/{API_KEY}/link"
    assert capture["params"]["url"] == SOURCE
    assert capture["params"]["p_data"] == p_data_for(SOURCE)
    assert "linkonly" not in capture["params"]  # 기본값 true 는 안 보냄

    assert result.status == STATUS_OK
    assert result.affiliate_url == "https://link.adpick.co.kr/xxxxxxxx"
    assert result.p_data == p_data_for(SOURCE)


async def test_convert_linkonly_false_captures_product_info(monkeypatch):
    capture: dict = {}
    body = {
        "success": True,
        "data": {
            "status": "success",
            "commissionlink": "https://link.adpick.co.kr/yyyy",
            "cp_name": "아고다",
            "commission_per": "3.0",
        },
    }
    monkeypatch.setattr(
        "app.services.adpick.httpx.AsyncClient", _fake_client(capture, body)
    )

    result = await AdpickClient(_api_settings(adpick_linkonly=False)).convert(SOURCE)

    assert capture["params"]["linkonly"] == "false"
    assert result.merchant_name == "아고다"
    assert result.commission_per == 3.0


async def test_convert_survives_api_error(monkeypatch):
    monkeypatch.setattr(
        "app.services.adpick.httpx.AsyncClient",
        _fake_client({}, boom=RuntimeError("timeout")),
    )
    settings = Settings(
        adpick_api_key=API_KEY,
        adpick_link_template="https://adpick.test/c/AB12?url={source_url}",
    )
    result = await AdpickClient(settings).convert(SOURCE)

    # API 가 죽어도 링크는 만들어져야 한다
    assert result.affiliate_url.startswith("https://adpick.test/c/AB12")
    assert result.error == "timeout"


async def test_api_key_never_leaks_into_error(monkeypatch):
    """애드픽은 API 키가 URL 경로에 들어간다(/api/{apikey}/link).

    httpx 예외 메시지에는 요청 URL 이 그대로 담기므로, 가리지 않으면
    키가 로그와 affiliate_links.error 컬럼에 남는다.
    """
    import httpx

    endpoint = f"https://biz.adpick.co.kr/api/{API_KEY}/link?url=x"
    boom = httpx.HTTPStatusError(
        f"Client error '403 Forbidden' for url '{endpoint}'",
        request=httpx.Request("GET", endpoint),
        response=httpx.Response(403),
    )
    monkeypatch.setattr(
        "app.services.adpick.httpx.AsyncClient", _fake_client({}, boom=boom)
    )

    result = await AdpickClient(_api_settings()).convert(SOURCE)

    assert API_KEY not in (result.error or "")
    assert "***" in result.error
    # 그래도 사용자는 호텔로 갈 수 있어야 한다
    assert result.affiliate_url == SOURCE


async def test_convert_handles_missing_commissionlink(monkeypatch):
    body = {"success": False, "message": "잘못된 URL"}
    monkeypatch.setattr(
        "app.services.adpick.httpx.AsyncClient", _fake_client({}, body)
    )
    result = await AdpickClient(_api_settings()).convert(SOURCE)

    # 원본 주소로라도 보낸다
    assert result.affiliate_url == SOURCE
    assert result.error == "잘못된 URL"


# ------------------------------------------------------------------ 폴백
async def test_no_api_key_uses_template():
    settings = Settings(
        adpick_api_key="",
        adpick_link_template="https://adpick.test/c/AB12?url={source_url}",
    )
    result = await AdpickClient(settings).convert(SOURCE)
    assert result.status == STATUS_FALLBACK
    assert result.affiliate_url.startswith("https://adpick.test/c/AB12")


async def test_no_api_key_no_template_falls_back_to_source():
    result = await AdpickClient(
        Settings(adpick_api_key="", adpick_link_template="")
    ).convert(SOURCE)
    # 수익화는 못 하더라도 사용자는 호텔 페이지로 갈 수 있어야 한다
    assert result.affiliate_url == SOURCE


@pytest.mark.parametrize("bad", ["", None])
async def test_empty_source_url_is_rejected(bad):
    result = await AdpickClient(_api_settings()).convert(bad or "")
    assert not result.ok

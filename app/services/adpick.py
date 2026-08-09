"""애드픽(제휴) 링크 처리.

중요: 카카오 카드 버튼에 애드픽 링크를 **직접** 넣으면 안 된다.
webLink 버튼은 브라우저를 바로 열기 때문에 우리 서버로 아무 신호가 오지 않고,
그러면 "사용자가 어떤 호텔을 골랐는지" 기록할 방법이 없다.

  카드 버튼 → https://{우리도메인}/r/{click_id} → (로그 적재) → 302 → 애드픽 링크

`build_target_url()` 은 마지막 302 목적지를 만든다.
애드픽이 서브 파라미터(subid 등)를 지원하면 click_id 를 실어 보내
나중에 전환 리포트와 정확히 매칭할 수 있다.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.core.config import Settings


def build_target_url(base_url: str, click_id: str, settings: Settings) -> str:
    """애드픽 딥링크에 click_id 서브 파라미터를 붙인다.

    ADPICK_SUBID_PARAM 이 비어 있으면 원본 URL 을 그대로 반환.
    """
    if not base_url:
        base_url = settings.adpick_default_url
    if not base_url:
        return ""

    param = (settings.adpick_subid_param or "").strip()
    if not param:
        return base_url

    parts = urlsplit(base_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault(param, click_id)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )

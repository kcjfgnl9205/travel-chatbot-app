"""애드픽 커미션 링크 생성 API 클라이언트.

    GET https://biz.adpick.co.kr/api/{apikey}/link?url={상품URL}&linkonly=true&p_data={코드}

    {"success": true, "message": "...",
     "data": {"status": "success", "commissionlink": "https://link.adpick.co.kr/xxxxxxxx"}}

흐름
    AI/크롤링 → 원본 호텔 주소(아고다 등)
      → 애드픽 link API 로 커미션 링크 생성   ← 여기
      → affiliate_links 에 캐시
      → 사용자에게는 커미션 링크만 노출

주의할 스펙 3가지
  1. **Rate limit**: linkonly=true 분당 60회 / linkonly=false 분당 10회 (API 키 기준).
     호텔 5건이면 캐시 미스 시 요청 1건에 5회를 쓴다. 캐시가 필수인 이유.
  2. **180일간 클릭 없는 링크는 삭제될 수 있다.** 그래서 노출마다 새 링크를 만들지 않고
     source_url 단위로 하나를 만들어 재사용한다.
  3. **p_data 는 링크 생성 시점에 박힌다.** 클릭 단위로 바꿀 수 없으므로
     source_url 단위 고정 코드를 쓴다.
     사용자별/클릭별 추적은 recommendation_items(노출 + click_count)가 담당한다.
"""

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx

from app.core.config import Settings

logger = logging.getLogger(__name__)

STATUS_OK = "ok"
STATUS_FAILED = "failed"
STATUS_FALLBACK = "fallback"

P_DATA_MAX = 50  # 애드픽 스펙: string(50)


@dataclass(slots=True)
class LinkResult:
    source_url: str
    affiliate_url: str | None
    status: str
    p_data: str | None = None
    merchant_name: str | None = None
    commission_per: float | None = None
    error: str | None = None
    raw: dict[str, Any] | None = None

    @property
    def ok(self) -> bool:
        return self.status in (STATUS_OK, STATUS_FALLBACK) and bool(self.affiliate_url)


def p_data_for(source_url: str) -> str:
    """source_url 하나당 고정되는 추적 코드.

    애드픽 성과 데이터 API 의 구분 코드와 우리 affiliate_links 행을 조인하는 키.
    링크를 캐시해서 재사용하므로 클릭마다 다르게 만들 수는 없다.
    """
    digest = hashlib.sha1(source_url.encode("utf-8")).hexdigest()[:15]
    return f"h_{digest}"[:P_DATA_MAX]


def render_template(template: str, source_url: str, click_id: str = "") -> str:
    """API 미설정 시 쓰는 폴백 템플릿. {source_url} / {click_id} 치환.

    URL 에 중괄호가 섞여도 안전하도록 str.format 대신 replace 를 쓴다.
    """
    return template.replace("{source_url}", quote(source_url, safe="")).replace(
        "{click_id}", click_id
    )


def apply_subid(url: str, click_id: str, settings: Settings) -> str:
    """최종 링크에 click_id 를 쿼리 파라미터로 붙인다.

    ⚠️ 애드픽 커미션 링크(link.adpick.co.kr/xxxxxxxx)는 이런 파라미터를 해석하지 않는다.
    애드픽 쪽 추적은 p_data 가 담당한다. 그래서 ADPICK_SUBID_PARAM 기본값은 비어 있고,
    이 함수는 다른 제휴사를 붙이거나 자체 랜딩을 쓸 때를 위해 남겨둔 것이다.
    """
    param = (settings.adpick_subid_param or "").strip()
    if not url or not param or f"{param}=" in url:
        return url
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault(param, click_id)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


class AdpickClient:
    """원본 주소 → 애드픽 커미션 링크.

    API 키가 없으면 템플릿으로, 템플릿도 없으면 원본 주소로 폴백한다.
    폴백이어도 챗봇은 정상 동작한다 — 수익화만 안 될 뿐.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        # rate limit(분당 60회) 대비. 동시 호출을 묶어서 버스트를 줄인다.
        self._gate = asyncio.Semaphore(max(1, settings.adpick_max_concurrency))

    @property
    def endpoint(self) -> str:
        base = self.settings.adpick_api_base.rstrip("/")
        return f"{base}/api/{self.settings.adpick_api_key}/link"

    async def convert(self, source_url: str, merchant: str | None = None) -> LinkResult:
        if not source_url:
            return LinkResult(source_url, None, STATUS_FAILED, error="empty source_url")

        if not self.settings.adpick_api_enabled:
            return self._fallback(source_url)

        p_data = p_data_for(source_url)
        params = {"url": source_url, "p_data": p_data}
        if not self.settings.adpick_linkonly:
            params["linkonly"] = "false"

        try:
            async with self._gate:
                async with httpx.AsyncClient(
                    timeout=self.settings.adpick_timeout_seconds
                ) as client:
                    response = await client.get(self.endpoint, params=params)
                    response.raise_for_status()
                    body = response.json()
        except Exception as exc:  # noqa: BLE001 — 변환 실패로 추천을 막지 않는다
            # ⚠️ 애드픽은 API 키가 URL 경로에 들어간다(/api/{apikey}/link).
            #    httpx 예외 메시지에는 요청 URL 이 그대로 담기므로,
            #    가리지 않으면 키가 로그와 affiliate_links.error 에 남는다.
            reason = self._redact(str(exc))
            logger.warning("adpick convert failed url=%s err=%s", source_url, reason)
            result = self._fallback(source_url)
            result.error = reason[:500]
            result.p_data = p_data
            return result

        return self._parse(body, source_url, p_data)

    # ---------------------------------------------------------------- 내부
    def _redact(self, text: str) -> str:
        """API 키를 가린다. 로그·DB·응답 어디로도 새면 안 된다."""
        key = self.settings.adpick_api_key
        return text.replace(key, "***") if key else text

    def _parse(self, body: Any, source_url: str, p_data: str) -> LinkResult:
        data = body.get("data") if isinstance(body, dict) else None
        raw = body if isinstance(body, dict) else {"raw": body}

        link = (data or {}).get("commissionlink") if isinstance(data, dict) else None
        if not isinstance(link, str) or not link.startswith("http"):
            message = (body or {}).get("message") if isinstance(body, dict) else None
            logger.warning(
                "adpick response had no commissionlink: %s",
                self._redact(str(body))[:200],
            )
            result = self._fallback(source_url)
            result.error = self._redact(
                str(message or "no commissionlink in response")
            )[:500]
            result.raw = raw
            result.p_data = p_data
            return result

        return LinkResult(
            source_url=source_url,
            affiliate_url=link,
            status=STATUS_OK,
            p_data=p_data,
            merchant_name=data.get("cp_name"),
            commission_per=_to_float(data.get("commission_per")),
            raw=raw,
        )

    def _fallback(self, source_url: str) -> LinkResult:
        template = self.settings.adpick_link_template.strip()
        if template:
            return LinkResult(
                source_url=source_url,
                affiliate_url=render_template(template, source_url),
                status=STATUS_FALLBACK,
            )
        # 템플릿도 없으면 원본 주소를 그대로 쓴다. 수익화는 안 되지만 챗봇은 산다.
        return LinkResult(source_url, source_url, STATUS_FALLBACK)


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

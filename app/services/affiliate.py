"""제휴 링크 해석: 캐시 조회 → 없으면 애드픽 변환 → 캐시 저장.

카카오 5초 예산 안에서 돌아야 하므로
  - 캐시 히트는 DB 조회 1번으로 끝내고
  - 미스만 동시(gather)에 변환한다.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.db.repositories import AffiliateLinkRepository
from app.services.adpick import STATUS_OK, AdpickClient, LinkResult

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ResolvedLink:
    source_url: str
    affiliate_url: str
    affiliate_link_id: str | None = None
    status: str = STATUS_OK
    from_cache: bool = False


class AffiliateResolver:
    def __init__(self, settings: Settings, db: Any | None) -> None:
        self.settings = settings
        self.repo = AffiliateLinkRepository(db)
        self.client = AdpickClient(settings)

    async def resolve(self, targets: list[tuple[str, str | None]]) -> dict[str, ResolvedLink]:
        """[(source_url, merchant), ...] → {source_url: ResolvedLink}."""
        wanted: dict[str, str | None] = {}
        for source_url, merchant in targets:
            if source_url:
                wanted.setdefault(source_url, merchant)
        if not wanted:
            return {}

        cached = await self.repo.find_usable(list(wanted))
        resolved: dict[str, ResolvedLink] = {
            url: ResolvedLink(
                source_url=url,
                affiliate_url=row["affiliate_url"],
                affiliate_link_id=row.get("id"),
                status=STATUS_OK,
                from_cache=True,
            )
            for url, row in cached.items()
        }

        misses = [url for url in wanted if url not in resolved]
        if not misses:
            return resolved

        results: list[LinkResult] = await asyncio.gather(
            *(self.client.convert(url, wanted[url]) for url in misses)
        )

        # 변환에 성공했든 폴백이든 기록해둔다. 실패 이유를 나중에 봐야 하므로.
        rows = [
            {
                "partner": "adpick",
                "merchant": wanted[r.source_url],
                "source_url": r.source_url,
                "affiliate_url": r.affiliate_url,
                "p_data": r.p_data,
                "merchant_name": r.merchant_name,
                "commission_per": r.commission_per,
                "status": r.status,
                "error": r.error,
                "raw_response": r.raw,
                "converted_at": "now()" if r.status == STATUS_OK else None,
            }
            for r in results
        ]
        saved = await self.repo.upsert_many(rows, self.settings.adpick_link_ttl_days)

        for result in results:
            if not result.ok:
                logger.warning(
                    "affiliate link unresolved url=%s status=%s err=%s",
                    result.source_url,
                    result.status,
                    result.error,
                )
                continue
            saved_row = saved.get(result.source_url) or {}
            resolved[result.source_url] = ResolvedLink(
                source_url=result.source_url,
                affiliate_url=result.affiliate_url or "",
                affiliate_link_id=saved_row.get("id"),
                status=result.status,
                from_cache=False,
            )
        return resolved

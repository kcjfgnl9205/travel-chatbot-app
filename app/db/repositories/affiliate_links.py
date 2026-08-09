from datetime import UTC, datetime, timedelta
from typing import Any

from app.db.repositories.base import BaseRepository


class AffiliateLinkRepository(BaseRepository):
    """원본 호텔 주소 → 애드픽 제휴 주소 변환 캐시.

    같은 호텔을 매번 애드픽 API 로 변환하면 카카오 5초 예산을 넘긴다.
    한 번 변환한 주소는 여기서 재사용한다.
    """

    table_name = "affiliate_links"

    async def find_usable(self, source_urls: list[str]) -> dict[str, dict]:
        """재사용 가능한(status=ok, 미만료) 변환 결과를 source_url 로 인덱싱해 돌려준다."""
        if not source_urls:
            return {}
        rows = await self.run(
            lambda q: q.select("id, source_url, affiliate_url, status, expires_at")
            .in_("source_url", source_urls)
            .eq("status", "ok"),
            op="select affiliate links",
        )
        now = datetime.now(UTC)
        usable: dict[str, dict] = {}
        for row in rows or []:
            if not row.get("affiliate_url"):
                continue
            if _expired(row.get("expires_at"), now):
                continue
            usable[row["source_url"]] = row
        return usable

    async def upsert_many(
        self, links: list[dict[str, Any]], ttl_days: int
    ) -> dict[str, dict]:
        """변환 결과를 저장하고 source_url → 행 매핑을 돌려준다."""
        if not links:
            return {}
        expires_at = None
        if ttl_days > 0:
            expires_at = (datetime.now(UTC) + timedelta(days=ttl_days)).isoformat()

        rows = [
            {**link, "expires_at": expires_at, "updated_at": "now()"} for link in links
        ]
        result = await self.run(
            lambda q: q.upsert(rows, on_conflict="partner,source_url"),
            op="upsert affiliate links",
        )
        return {r["source_url"]: r for r in (result or []) if r.get("source_url")}


def _expired(expires_at: Any, now: datetime) -> bool:
    if not expires_at:
        return False  # null = 무기한
    try:
        return datetime.fromisoformat(str(expires_at)) <= now
    except ValueError:
        return False

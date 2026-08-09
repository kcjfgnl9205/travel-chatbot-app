from typing import Any

from app.db.repositories.base import BaseRepository


class MessageRepository(BaseRepository):
    table_name = "messages"

    async def log(
        self,
        *,
        user_id: str | None,
        domain: str,
        utterance: str,
        block_name: str | None = None,
        parsed_city: str | None = None,
        params: dict[str, Any] | None = None,
        raw_payload: dict[str, Any] | None = None,
    ) -> dict | None:
        record = {
            "user_id": user_id,
            "domain": domain,
            "utterance": utterance,
            "block_name": block_name,
            "parsed_city": parsed_city,
            "params": params or {},
            "raw_payload": raw_payload,
        }
        return await self.run_one(lambda q: q.insert(record), op="insert message")

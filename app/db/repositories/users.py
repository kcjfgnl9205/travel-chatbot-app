from app.db.repositories.base import BaseRepository


class UserRepository(BaseRepository):
    table_name = "users"

    async def get_or_create(self, kakao_user_key: str) -> dict | None:
        """카카오 botUserKey 로 사용자 upsert 후 행을 돌려준다."""
        row = await self.run_one(
            lambda q: q.select("*").eq("kakao_user_key", kakao_user_key).limit(1),
            op="select user",
        )
        if row:
            return row
        return await self.run_one(
            lambda q: q.upsert(
                {"kakao_user_key": kakao_user_key}, on_conflict="kakao_user_key"
            ),
            op="upsert user",
        )

    async def touch(self, user_id: str, message_count: int) -> None:
        await self.run(
            lambda q: q.update(
                {"last_seen_at": "now()", "message_count": message_count + 1}
            ).eq("id", user_id),
            op="touch user",
        )

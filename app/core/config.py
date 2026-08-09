from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_env: str = "local"
    log_level: str = "INFO"
    public_base_url: str = "http://localhost:8000"

    supabase_url: str = ""
    supabase_service_role_key: str = ""

    adpick_subid_param: str = "subid"
    adpick_default_url: str = ""

    kakao_skill_token: str = ""

    hotel_provider: str = "static"
    hotel_result_limit: int = 5

    @property
    def db_enabled(self) -> bool:
        """Supabase 자격증명이 없으면 no-op 모드로 돈다."""
        return bool(self.supabase_url and self.supabase_service_role_key)

    def redirect_url(self, click_id: str) -> str:
        return f"{self.public_base_url.rstrip('/')}/r/{click_id}"


@lru_cache
def get_settings() -> Settings:
    return Settings()

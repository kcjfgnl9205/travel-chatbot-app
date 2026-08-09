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

    # ---- 애드픽 ----
    # GET {base}/api/{key}/link?url=...  키가 없으면 템플릿/원본주소로 폴백한다.
    adpick_api_base: str = "https://biz.adpick.co.kr"
    adpick_api_key: str = ""
    adpick_timeout_seconds: float = 2.0
    # true: 링크만 (분당 60회) / false: 상품정보 포함 (분당 10회, 느리고 실패 가능)
    adpick_linkonly: bool = True
    # rate limit 대비 동시 호출 상한
    adpick_max_concurrency: int = 5
    # API 없이 쓰는 폴백 템플릿. {source_url}(URL 인코딩됨) / {click_id} 치환.
    adpick_link_template: str = ""
    # 변환 결과 재사용 기간. 0 이면 무기한. (애드픽은 180일 무클릭 링크를 지울 수 있음)
    adpick_link_ttl_days: int = 30
    # 최종 링크에 click_id 를 붙일 파라미터명.
    # 애드픽 커미션 링크는 이걸 해석하지 않으므로 기본은 비활성(빈 값).
    adpick_subid_param: str = ""

    kakao_skill_token: str = ""

    hotel_provider: str = "static"
    hotel_result_limit: int = 5

    # 검색 결과 캐시 유지 시간(분). 0 이면 캐시 사용 안 함.
    # AI/크롤링 provider 가 붙으면 이 값이 비용과 응답 속도를 좌우한다.
    # 너무 길면 오래된 가격을 보여주고, 너무 짧으면 캐시가 무의미해진다.
    search_cache_ttl_minutes: int = 60

    @property
    def db_enabled(self) -> bool:
        """Supabase 자격증명이 없으면 no-op 모드로 돈다."""
        return bool(self.supabase_url and self.supabase_service_role_key)

    @property
    def adpick_api_enabled(self) -> bool:
        return bool(self.adpick_api_key and self.adpick_api_base)

    def redirect_url(self, click_id: str) -> str:
        return f"{self.public_base_url.rstrip('/')}/r/{click_id}"


@lru_cache
def get_settings() -> Settings:
    return Settings()

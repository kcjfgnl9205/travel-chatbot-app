from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, status

from app.core.config import Settings, get_settings
from app.db.supabase_client import get_client

SettingsDep = Annotated[Settings, Depends(get_settings)]


async def get_db(settings: SettingsDep) -> Any | None:
    """Supabase AsyncClient. 미설정이면 None (no-op 모드)."""
    return await get_client(settings)


DbDep = Annotated[Any, Depends(get_db)]


async def verify_skill_token(
    settings: SettingsDep,
    x_skill_token: Annotated[str | None, Header()] = None,
) -> None:
    """KAKAO_SKILL_TOKEN 을 설정한 경우에만 검증한다.

    카카오 스킬 서버는 URL만 알면 아무나 호출할 수 있으므로,
    운영에서는 오픈빌더 스킬 헤더에 토큰을 넣고 이 값을 채우는 걸 권장.
    """
    if not settings.kakao_skill_token:
        return
    if x_skill_token != settings.kakao_skill_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid skill token"
        )

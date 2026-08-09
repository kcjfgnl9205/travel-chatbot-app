"""카카오 i 오픈빌더 스킬 요청 페이로드 모델.

오픈빌더는 필드를 조금씩 바꿔서 보내기도 하므로 전부 optional 로 두고
`extra="allow"` 로 원본을 잃지 않게 한다.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Loose(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class KakaoUser(_Loose):
    id: str | None = None
    type: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)

    @property
    def key(self) -> str:
        """사용자 식별자. botUserKey 우선, 없으면 user.id."""
        return str(
            self.properties.get("botUserKey")
            or self.properties.get("plusfriendUserKey")
            or self.id
            or "unknown"
        )


class KakaoBlock(_Loose):
    id: str | None = None
    name: str | None = None


class KakaoUserRequest(_Loose):
    utterance: str = ""
    user: KakaoUser = Field(default_factory=KakaoUser)
    block: KakaoBlock = Field(default_factory=KakaoBlock)
    params: dict[str, Any] = Field(default_factory=dict)
    timezone: str | None = None
    lang: str | None = None
    callbackUrl: str | None = None


class KakaoAction(_Loose):
    id: str | None = None
    name: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    detailParams: dict[str, Any] = Field(default_factory=dict)
    clientExtra: dict[str, Any] = Field(default_factory=dict)


class KakaoSkillPayload(_Loose):
    userRequest: KakaoUserRequest = Field(default_factory=KakaoUserRequest)
    action: KakaoAction = Field(default_factory=KakaoAction)
    bot: dict[str, Any] = Field(default_factory=dict)
    intent: dict[str, Any] = Field(default_factory=dict)

    # ---- 편의 접근자 ----
    @property
    def utterance(self) -> str:
        return (self.userRequest.utterance or "").strip()

    @property
    def user_key(self) -> str:
        return self.userRequest.user.key

    @property
    def block_name(self) -> str | None:
        return self.userRequest.block.name

    def param(self, *names: str) -> str | None:
        """action.params → detailParams.value → userRequest.params 순으로 조회."""
        for name in names:
            value = self.action.params.get(name)
            if value:
                return str(value)
            detail = self.action.detailParams.get(name)
            if isinstance(detail, dict) and detail.get("value"):
                return str(detail["value"])
            value = self.userRequest.params.get(name)
            if value:
                return str(value)
        return None

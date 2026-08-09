import os

import pytest

# 로컬 .env 가 있어도 테스트는 DB 없는 no-op 모드로 고정한다.
# (환경변수가 .env 보다 우선순위가 높다)
os.environ.update(
    {
        "SUPABASE_URL": "",
        "SUPABASE_SERVICE_ROLE_KEY": "",
        "PUBLIC_BASE_URL": "http://testserver",
        "ADPICK_SUBID_PARAM": "subid",
        "KAKAO_SKILL_TOKEN": "",
    }
)

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.db import memory_store
from app.main import app


@pytest.fixture(autouse=True)
def _clean_state():
    get_settings.cache_clear()
    memory_store.clear()
    yield
    memory_store.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def kakao_payload(utterance: str, user_key: str = "test-user", **params) -> dict:
    return {
        "intent": {"id": "intent-1", "name": "블록 이름"},
        "userRequest": {
            "timezone": "Asia/Seoul",
            "params": {},
            "block": {"id": "block-1", "name": "호텔추천"},
            "utterance": utterance,
            "lang": "kr",
            "user": {
                "id": user_key,
                "type": "accountId",
                "properties": {"botUserKey": user_key},
            },
        },
        "bot": {"id": "bot-1", "name": "여행봇"},
        "action": {
            "name": "호텔추천액션",
            "clientExtra": {},
            "params": params,
            "detailParams": {},
            "id": "action-1",
        },
    }

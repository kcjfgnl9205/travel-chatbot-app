from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.v1 import health, redirect
from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.logging import setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(settings.log_level)
    app.state.settings = settings
    yield


app = FastAPI(
    title="travel-chatbot-app",
    description="카카오톡 여행 챗봇 스킬 서버 (호텔 MVP)",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(api_router)
# 리다이렉트는 링크 길이를 줄이려고 루트에 붙인다: /r/{click_id}
app.include_router(redirect.router)
app.include_router(health.router)

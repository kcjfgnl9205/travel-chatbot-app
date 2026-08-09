from fastapi import APIRouter

from app.api.v1 import kakao_hotel

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(kakao_hotel.router)

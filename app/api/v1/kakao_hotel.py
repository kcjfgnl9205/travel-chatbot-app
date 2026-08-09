import logging

from fastapi import APIRouter, Depends

from app.api.deps import DbDep, SettingsDep, verify_skill_token
from app.domain.hotel.service import HotelRecommendService
from app.kakao import templates as t
from app.kakao.schemas import KakaoSkillPayload
from app.services import nlu

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/kakao",
    tags=["kakao"],
    dependencies=[Depends(verify_skill_token)],
)


@router.post("/hotels/recommend")
async def recommend_hotels(
    payload: KakaoSkillPayload, settings: SettingsDep, db: DbDep
) -> dict:
    """오픈빌더 [호텔추천] 블록 스킬.

    어떤 예외가 나도 카카오에는 200 + 안내 문구를 돌려준다.
    500을 내면 사용자에게 "오류가 발생했습니다"만 뜨고 원인 추적이 어렵다.
    """
    try:
        service = HotelRecommendService(settings, db)
        return await service.handle(payload)
    except Exception:
        logger.exception("hotel recommend failed: utterance=%r", payload.utterance)
        return t.simple_text(
            "일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요 🙏",
            quick_replies=[
                t.quick_reply(f"{c['name_ko']} 호텔", f"{c['name_ko']} 호텔 추천해줘")
                for c in nlu.CITIES
            ],
        )


@router.post("/fallback")
async def fallback(payload: KakaoSkillPayload) -> dict:
    """폴백 블록. 도시가 섞여 있으면 안내 문구를 도시에 맞춰준다."""
    parsed = nlu.parse(payload.utterance)
    if parsed.has_city:
        text = f"{parsed.city_name} 호텔을 찾으시나요? 아래 버튼을 눌러보세요!"
    else:
        text = (
            "아직은 호텔 추천만 도와드릴 수 있어요.\n"
            "예) 오사카 호텔 추천해줘"
        )
    return t.simple_text(
        text,
        quick_replies=[
            t.quick_reply(f"{c['name_ko']} 호텔", f"{c['name_ko']} 호텔 추천해줘")
            for c in nlu.CITIES
        ],
    )

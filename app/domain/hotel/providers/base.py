from abc import ABC, abstractmethod

from app.domain.hotel.schemas import Hotel, HotelQuery


class HotelProvider(ABC):
    """호텔 검색 소스.

    async 로 두는 이유: Phase 3에서 크롤링/LLM provider 로 바꿔도
    호출부(service)를 안 고치기 위해서. 단, 그때는 카카오 5초 제한을 넘기므로
    콜백(useCallback) 방식으로 전환해야 한다.
    """

    name: str = "base"

    @abstractmethod
    async def search(self, query: HotelQuery) -> list[Hotel]: ...

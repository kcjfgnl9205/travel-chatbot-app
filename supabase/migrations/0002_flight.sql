-- 항공권 도메인 추가 (0001 다음에 실행. 재실행해도 안전하다)
--
-- **새 테이블이 없다.** 항공권은 호텔과 같은 테이블을 그대로 쓴다 —
-- messages / recommendations / recommendation_items / affiliate_links / search_cache.
-- domain 컬럼('hotel' | 'flight')이 둘을 가른다.
--
-- 도메인마다 테이블을 복제하지 않는 이유
--   · 집계 질문이 도메인을 가로지른다 ("이번 주 클릭 수", "전환율").
--     테이블이 갈리면 모든 질의가 union 이 된다.
--   · 클릭 추적 경로(register_click → /r/{click_id})가 하나뿐이라
--     테이블이 늘면 리다이렉트가 어느 테이블을 볼지 먼저 알아내야 한다.
--   · recommendation_items 는 "노출 1건 + 클릭 카운터" 라는 뜻이지
--     "호텔 1건" 이라는 뜻이 아니다.
--
-- 그래서 이 파일이 하는 일은 **컬럼 이름이 거짓말하지 않게 주석을 고치는 것**뿐이다.
-- 컬럼 이름 자체는 바꾸지 않는다 — 이름을 바꾸면 register_click() 의 반환 시그니처와
-- 앱의 읽기 코드까지 같이 옮겨야 하고, 그 사이 배포에서 클릭이 유실된다.
-- 이름이 hotel_name 인 채로 항공편 이름이 들어가는 게 그 위험보다 낫다.

comment on column public.recommendation_items.hotel_name is
    '노출 시점의 항목 이름 스냅샷. 도메인에 따라 내용이 다르다 — '
    'hotel: 호텔명("호텔 그란비아 오사카"), '
    'flight: 항공편("대한항공 KE723 ICN→KIX"). '
    '컬럼 이름은 호텔만 있던 시절의 잔재다 (0002 마이그레이션 참고). '
    '항목 단위 집계는 이 컬럼이 아니라 source_url 로 한다.';

comment on column public.recommendation_items.price_from is
    'hotel: 1박 최저가(원). flight: 1인 총액(원). '
    '⚠️ 항공권은 웹 검색으로 얻은 예상가이므로 확정 운임이 아니다.';

comment on column public.recommendation_items.source_url is
    '예약 페이지 주소 스냅샷. '
    'hotel: 호텔 1곳당 고유하므로 호텔의 신원 역할을 한다. '
    '⚠️ flight: 여러 항공편이 같은 노선 검색 페이지를 공유할 수 있어 편의 신원이 아니다 '
    '(항공편 신원은 편명+출발시각. 앱의 flightKey() 참고).';

comment on column public.recommendation_items.thumbnail_url is
    'hotel: 예약 페이지에서 긁어온 대표 이미지. flight: 항상 null (카드에 이미지가 없다).';

comment on column public.messages.parsed_city is
    '파싱된 도시 slug. null 이면 파싱 실패. '
    'hotel: 숙박 도시. flight: **목적지** 도시 (출발지는 남기지 않는다).';

comment on column public.recommendations.city_slug is
    'hotel: 숙박 도시. flight: 목적지 도시.';

comment on column public.recommendations.guests is
    'hotel: 투숙 인원. flight: 탑승 인원.';

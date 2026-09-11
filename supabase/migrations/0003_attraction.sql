-- 관광지 도메인 추가 (0002 다음에 실행. 재실행해도 안전하다)
--
-- 0002 와 마찬가지로 **새 테이블이 없다.** domain 컬럼이
-- 'hotel' | 'flight' | 'attraction' 세 값을 갖게 되는 것뿐이다.
--
-- 관광지가 앞의 둘과 다른 점은 하나다: **제휴 링크를 타지 않는다.**
-- 관광지는 우리가 파는 게 아니라 장소라서 애드픽에 변환할 주소가 없다.
-- 그래서 이 도메인의 행은 affiliate_link_id 가 항상 null 이고,
-- source_url = target_url 이며, 그 값은 우리가 이름+도시로 만든 구글맵 주소다.
--
-- ⚠️ 전환율·수익 집계에서 관광지를 빼야 한다. 안 그러면 "클릭은 많은데 수수료가
--    0" 인 행들이 섞여 커미션 도메인의 전환율이 실제보다 나빠 보인다.
--    도메인을 나눠서 보는 게 맞다 (아래 예시 참고).

comment on column public.recommendation_items.affiliate_link_id is
    '애드픽 변환 결과. hotel/flight 는 값이 있어야 정상이고(null 이면 변환 실패라 '
    '수익화가 안 된 노출이다), attraction 은 **항상 null 이 정상이다** — '
    '관광지는 제휴 링크를 타지 않는다.';

comment on column public.recommendation_items.target_url is
    '302 목적지 (노출 시점 스냅샷). '
    'hotel/flight: 애드픽 커미션 링크(변환 실패 시 원본 예약 주소). '
    'attraction: 구글맵 검색 주소 — 모델이 준 게 아니라 이름+도시로 서버가 만든 값이다.';

comment on column public.recommendation_items.source_url is
    '예약/목적지 주소 스냅샷. 항목 단위 집계는 이름이 아니라 이 컬럼으로 한다. '
    'hotel: 예약 페이지. 호텔 1곳당 고유하므로 호텔의 신원이다. '
    '⚠️ flight: 여러 항공편이 같은 노선 검색 페이지를 공유해 편의 신원이 아니다 '
    '(신원은 편명+출발시각. 앱의 flightKey() 참고). '
    'attraction: 구글맵 주소. 이름+도시로 결정되는 값이라 관광지의 신원 역할을 한다 '
    '(target_url 과 같은 값이다 — 중간에 제휴 변환이 없다).';

comment on column public.recommendation_items.price_from is
    '단위는 **원**이다. '
    'hotel: 1박 최저가. '
    'flight: 1인 총액. ⚠️ 웹 검색으로 얻은 예상가이지 확정 운임이 아니다. '
    'attraction: **항상 null.** 관광지 입장료는 현지 통화(엔·바트·동)라 이 칸에 넣으면 '
    '비교 불가능한 숫자가 섞인다(통화 컬럼이 없다). 입장료는 카드와 search_cache 에만 '
    '남긴다 — 환율 API 로 원화를 확정할 수 있게 되면 그때 채우면 된다. '
    '⚠️ 도메인마다 의미가 다르므로 domain 없이 평균을 내면 안 된다.';

comment on column public.recommendation_items.thumbnail_url is
    'hotel: 예약 페이지에서 긁어온 대표 이미지. '
    'flight/attraction: 항상 null (카드에 이미지가 없다). '
    '관광지는 긁어올 예약 페이지 자체가 없어서 이미지 출처가 없다.';

comment on column public.messages.parsed_city is
    '파싱된 도시 slug. null 이면 파싱 실패. '
    'hotel: 숙박 도시. flight: **목적지** 도시(출발지는 남기지 않는다). '
    'attraction: 관광 도시. '
    'hotel 과 attraction 은 같은 파서(NluService)를 쓰므로 같은 문장이면 같은 값이 된다.';

comment on column public.recommendations.city_slug is
    'hotel: 숙박 도시. flight: 목적지 도시. attraction: 관광 도시.';

comment on column public.recommendations.guests is
    'hotel: 투숙 인원. flight: 탑승 인원. attraction: 항상 null (인원 개념이 없다).';

comment on column public.recommendations.domain is
    '유스케이스 구분: hotel | flight | attraction. '
    '⚠️ 수익 관련 집계(전환율·커미션)에서는 attraction 을 제외해야 한다 — '
    '제휴 링크가 없어 구조적으로 수수료가 0 이다.';

-- 집계 예시 — 도메인을 섞지 않는다
--
--   -- 도메인별 CTR
--   select r.domain,
--          count(*)                                  as impressions,
--          sum(case when i.click_count > 0 then 1 end) as clicked,
--          round(100.0 * sum(case when i.click_count > 0 then 1 end) / count(*), 1) as ctr
--     from recommendation_items i
--     join recommendations r on r.id = i.recommendation_id
--    group by r.domain;
--
--   -- 수익화 누수 (관광지는 애초에 대상이 아니므로 제외)
--   select count(*) as 변환실패_노출
--     from recommendation_items i
--     join recommendations r on r.id = i.recommendation_id
--    where r.domain in ('hotel', 'flight')
--      and i.affiliate_link_id is null;

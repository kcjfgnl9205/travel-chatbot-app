-- 노출 스냅샷을 한 테이블로 되돌린다 (0012 다음. 재실행해도 안전하다)
--
-- **0007 이 갈라놓은 것을 도로 합친다.** 그때는 "도메인마다 남길 값이 다르다" 가
-- 이유였고 맞는 말이었는데, 그 뒤로 전제가 두 번 바뀌었다 —
--
--   0012  관광지가 이 구조에서 빠졌다. 세 도메인이라 갈랐던 것이 둘이 됐다.
--   지금  기획이 요구하는 값이 **이름 · 링크 · 사진 · 가격 · 클릭 수** 뿐이다.
--         성급 · 리뷰점수 · 경유 · 좌석등급 · 비행시간은 카드에 찍히기만 하고
--         (그 값은 search_results 에서 온다) 아무도 DB 에서 읽지 않았다.
--
-- 위성 테이블 둘이 남긴 것은 조인 하나와, 노출마다 insert 두 번이다. 읽는 쪽이
-- 없는 칸 때문에 그걸 계속 낼 이유가 없다.
--
--   recommendation_items   id · recommendation_id · domain · position · click_id
--                          item_name · source_url · target_url
--                          price · merchant · image_url · affiliate_link_id   ← 올라옴
--                          click_count · first/last_clicked_at · created_at
--
-- ⚠️ **price 는 호텔 1박가와 항공권 1인 총액이 한 칸에 들어간다.** 0007 이 이걸
--    price_per_night / price_total 로 갈라놨던 이유가 "같은 칸에 있으면 안 되는
--    값" 이어서였고, 그 걱정 자체는 여전히 맞다. **domain 없이 평균을 내면 안 된다.**
--    다만 도메인을 안 거르고 가격을 집계할 일이 실제로 없어서, 칸 하나를 줄이는
--    쪽을 택했다. 집계 예시는 파일 끝에 domain 을 걸어 적어뒀다.
--
-- 사라지는 값: star_rating · review_score · airline · stops · cabin ·
--             duration_minutes. **되돌릴 수 없다.** 기획 어디에도 안 나오고 읽는
--             코드도 없었지만, 지난 노출의 그 값들은 여기서 버려진다.

-- ------------------------------------------------------------------ 공통 칸
alter table public.recommendation_items
    add column if not exists price             integer check (price is null or price > 0),
    add column if not exists merchant          text,
    add column if not exists image_url         text,
    add column if not exists affiliate_link_id uuid
        references public.affiliate_links (id) on delete set null;

comment on column public.recommendation_items.price is
    '노출 시점 가격(원). ⚠️ **domain 으로 의미가 갈린다** — hotel: 1박 최저가, '
    'flight: 1인 총액. domain 없이 평균을 내면 비교 불가능한 값이 섞인다. '
    'flight 는 웹 검색으로 얻은 예상가이지 확정 운임이 아니다.';

comment on column public.recommendation_items.affiliate_link_id is
    '애드픽 변환 결과. **null 이면 수익화가 안 된 노출이다**(변환 실패). '
    '변환에 실패해도 행은 남는다 — 안 그러면 수수료가 새는 노출이 집계에서 통째로 빠진다.';

comment on column public.recommendation_items.image_url is
    '카드 썸네일 스냅샷. hotel: 예약 페이지에서 긁어온 대표 이미지. '
    'flight: 항상 null (항공권 카드에는 이미지가 없다).';

-- ------------------------------------------------------- 위성 테이블에서 끌어올린다
-- **`to_regclass` 가 곧 재실행 방지다** — 아래에서 테이블을 지우므로 두 번째
-- 실행에는 이 블록이 통째로 건너뛰어진다 (0012 와 같은 방식).
do $$
begin
    if to_regclass('public.recommendation_item_hotels') is not null then
        update public.recommendation_items i
           set price             = h.price_per_night,
               merchant          = h.merchant,
               image_url         = h.image_url,
               affiliate_link_id = h.affiliate_link_id
          from public.recommendation_item_hotels h
         where h.item_id = i.id;
    end if;

    if to_regclass('public.recommendation_item_flights') is not null then
        update public.recommendation_items i
           set price             = f.price_total,
               merchant          = f.merchant,
               affiliate_link_id = f.affiliate_link_id
          from public.recommendation_item_flights f
         where f.item_id = i.id;
    end if;
end $$;

drop table if exists public.recommendation_item_hotels;
drop table if exists public.recommendation_item_flights;

-- 수익화 누수를 보는 질의가 조인 없이 돌아야 한다. 부분 인덱스라 작다.
create index if not exists recommendation_items_unconverted_idx
    on public.recommendation_items (domain)
    where affiliate_link_id is null;

-- ------------------------------------------------------------------ 죽은 테이블
-- 0001 이 만든 검색 캐시. **0004 에서 search_results 로 갈아탄 뒤 아무도 안 읽는다**
-- (코드 참조 0건). EXPECTED_TABLES 에서도 이미 빠져 있어 헬스체크가 안 찌른다.
drop table if exists public.search_cache;

-- 집계 예시 — ⚠️ 가격을 볼 때는 **반드시 domain 을 건다**
--
--   -- 많이 눌린 항목 (관광지는 attractions 의 카운터로 따로 본다 — 0012)
--   select domain, item_name, count(*) as 노출, sum(click_count) as 클릭
--     from recommendation_items
--    where domain in ('hotel', 'flight')
--    group by 1, 2 order by 4 desc limit 20;
--
--   -- 도메인별 CTR · 줄 순서의 영향
--   select domain, position,
--          count(*)                                as 노출,
--          count(*) filter (where click_count > 0) as 클릭된줄
--     from recommendation_items group by 1, 2 order by 1, 2;
--
--   -- 수익화 누수. 제휴를 타는 두 도메인만 본다
--   select domain, count(*) as 변환실패_노출
--     from recommendation_items
--    where domain in ('hotel', 'flight') and affiliate_link_id is null
--    group by domain;
--
--   -- 가격대별로 눌리나. domain 을 안 걸면 1박가와 총액이 섞인다
--   select width_bucket(price, 0, 500000, 10) * 50000 as 가격대,
--          count(*) as 노출, count(*) filter (where click_count > 0) as 클릭된줄
--     from recommendation_items
--    where domain = 'hotel' and price is not null
--    group by 1 order by 1;

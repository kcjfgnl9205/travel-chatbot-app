-- 노출 스냅샷을 도메인별로 가른다 (0006 다음에 실행. 재실행해도 안전하다)
--
-- 0002·0003 은 "새 테이블이 없다" 로 버텼다. 도메인이 늘어도 하는 일이 같았기
-- 때문인데, **남길 값은 같지 않았다.** 관광지 입장료·항공편 경유 횟수·호텔 평점은
-- 담을 칸이 없어서 카드에만 찍히고 버려졌다.
--
-- 왜 search_results 로는 안 되나 — 거기에 도메인 객체가 통째로 있지만 그건
-- **캐시라서 갱신되면 덮어써진다.** 같은 cache_key 를 다시 검색하면 이전 값이
-- 사라지므로 "그때 사용자가 본 입장료" 는 영영 복원되지 않는다. 0001 이 이
-- 테이블을 스냅샷으로 만든 이유가 정확히 그것이다.
--
-- **공통에는 세 도메인이 전부 쓰는 것만 남기고 나머지는 전부 내린다.**
--
--   recommendation_items                 click_id · position · 이름 · 주소 · 클릭 카운터
--     ├─ recommendation_item_attractions 입장료 · 통화 · 소요시간 · 카테고리 · 사진
--     ├─ recommendation_item_hotels      성급 · 평점 · 1박가 · 판매처 · 제휴링크 · 사진
--     └─ recommendation_item_flights     항공사 · 경유 · 좌석 · 비행시간 · 총액 · 판매처 · 제휴링크
--
-- 내려간 것들은 **원래 한 도메인이나 두 도메인만 쓰던 칸이다.** 관광지 행에는
-- price_from·merchant·affiliate_link_id 가 늘 null 이었고, 항공권 행에는
-- thumbnail_url 이 늘 null 이었다.
--
-- ⚠️ **price_from 은 이름까지 갈랐다** (price_per_night / price_total). 호텔은
--    1박 최저가, 항공권은 1인 총액이라 **같은 칸에 있으면 안 되는 값**이었다.
--    0003 이 "domain 없이 평균을 내면 안 된다" 고 경고로만 막고 있었는데,
--    테이블이 갈리면 경고가 필요 없다.
--
-- 왜 공통 테이블을 아예 없애지 않았나 — **click_id · target_url · click_count 는
-- 반드시 한 테이블에 같이 있어야 한다.** /r/{clickId} 요청이 들고 오는 건 click_id
-- 하나뿐이고, 거기서 목적지를 찾아 카운터를 올리는 걸 register_click() 이 왕복
-- 1회·원자적으로 끝낸다. 이 셋을 흩으면 사용자가 302 를 기다리는 경로가 느려진다.
-- 그 셋을 공통에 두는 이상 position·item_name·source_url 처럼 세 도메인이 똑같이
-- 쓰는 값도 같이 두는 게 맞다 — 내려봐야 세 벌이 될 뿐이다.
--
-- ⚠️ **이 파일을 적용한 뒤에는 0001·0002 를 다시 돌릴 수 없다.** 아래에서
--    hotel_name 을 item_name 으로 바꾸기 때문에, 그 이름을 쓰는 0001 의
--    register_click() 과 0002·0003 의 comment 가 "컬럼이 없다" 로 실패한다
--    (price_from·thumbnail_url 도 여기서 옮겨가므로 0003 도 마찬가지다).
--    컬럼 개명이면 어느 마이그레이션에서든 생기는 일이고, 순서대로 한 번씩
--    적용하는 정상 경로(빈 DB → 0001…0007)는 그대로 돈다. 전체 재적용이
--    필요하면 빈 DB 에서 하라.

-- -------------------------------------------------------------- domain
-- 어느 위성 테이블을 봐야 하는지, 그리고 조인 없이 도메인별로 거르는 값.
alter table public.recommendation_items
    add column if not exists domain text;

-- 기존 행은 부모가 이미 안다.
update public.recommendation_items i
   set domain = r.domain
  from public.recommendations r
 where r.id = i.recommendation_id
   and i.domain is null;

-- not null 로 묶지 않는다. 이 파일이 새 코드보다 먼저 돌 수 있고, 그때 들어오는
-- 행은 domain 이 비는데 그것 때문에 노출 기록이 통째로 실패하면 안 된다.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'recommendation_items_domain_check'
    ) then
        alter table public.recommendation_items
            add constraint recommendation_items_domain_check
            check (domain is null or domain in ('hotel', 'flight', 'attraction'));
    end if;
end $$;

create index if not exists recommendation_items_domain_idx
    on public.recommendation_items (domain, created_at desc);

comment on column public.recommendation_items.domain is
    'hotel | flight | attraction. recommendations.domain 의 사본이다 — 조인 없이 '
    '도메인별로 거르고, 어느 위성 테이블에 상세가 있는지 가리킨다. '
    '부모가 진실이고 이 값은 행이 만들어질 때 한 번 정해진다.';

-- 이 파일은 도메인 값을 item_meta jsonb 한 칸에 담는 모양으로 먼저 쓰였다가
-- 도메인 테이블로 바뀌었다. 그 버전을 이미 돌린 DB 가 있으므로 여기서 치운다
-- (그 칸을 쓰는 코드는 배포된 적이 없어 지워도 잃을 데이터가 없다).
alter table public.recommendation_items drop column if exists item_meta;

-- ------------------------------------------------ hotel_name → item_name
-- 0002 는 이 칸에 항공편명이 들어가는 걸 알면서도 이름을 그대로 뒀다. 그때는
-- 개명만을 위한 마이그레이션이 위험 대비 실익이 없었기 때문이고, 이제 어차피
-- 이 테이블을 건드리는 김에 바꾼다 (DB.md 도 같은 제안을 적어뒀다).
do $$
begin
    if exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'recommendation_items'
           and column_name = 'hotel_name'
    ) and not exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'recommendation_items'
           and column_name = 'item_name'
    ) then
        alter table public.recommendation_items rename column hotel_name to item_name;
    end if;
end $$;

comment on column public.recommendation_items.item_name is
    '노출된 항목의 이름 스냅샷. hotel: 호텔명. flight: 항공사+편명+구간 '
    '("대한항공 KE723 ICN→KIX"). attraction: 관광지명. '
    '⚠️ 항목 단위 집계는 이 칸이 아니라 source_url 로 한다 — AI 가 표기를 매번 다르게 준다.';

-- ------------------------------------------------------- 도메인별 위성 테이블
-- 노출 1건당 0 또는 1행. **없어도 정상이다** — 남길 값이 하나도 없는 노출은 행이
-- 안 생긴다. 그래서 집계는 항상 join 이고, 그 join 이 곧 "이 도메인의 노출" 이다.
--
-- ⚠️ **값 목록(카테고리·통화·좌석등급·판매처)에는 check 를 걸지 않는다.** 저장소가
--    실패를 삼키는 구조라(base.repository — 로깅 실패로 사용자 응답을 막지 않는다),
--    check 에 걸린 행은 경고 한 줄만 남기고 조용히 사라진다. 앱에 카테고리를
--    하나 추가한 날부터 기록이 안 남는데 아무도 모르는 게 최악이다.
--    반면 숫자 범위(성급 1~5)는 물리적으로 안 늘어나므로 걸어둔다.

create table if not exists public.recommendation_item_attractions (
    item_id            uuid primary key
                       references public.recommendation_items (id) on delete cascade,
    -- ⚠️ **현지 통화 그대로다.** 원화 환산을 하지 않는다 (0003 주석 참고).
    --    금액이 있으면 통화도 있어야 읽을 수 있다. 원화 칸(price_*)이 아예 없는 게
    --    이 테이블의 요점이다 — 엔·바트·동을 원으로 읽는 사고가 생길 자리가 없다.
    admission_fee      integer check (admission_fee is null or admission_fee > 0),
    admission_currency text,
    duration_minutes   integer check (duration_minutes is null or duration_minutes > 0),
    -- 역사/문화 · 자연/공원 · 테마파크 · 거리/쇼핑 · 전망 · 미술관/박물관 · 음식/시장 · 체험
    category           text,
    -- 위키백과에서 찾은 사진. 열에 아홉은 아니다(실측 87%).
    image_url          text
);

comment on table public.recommendation_item_attractions is
    '관광지 노출 1건. 판매처·제휴링크·원화 가격 칸이 없는 것이 이 도메인의 정체다 — '
    '관광지는 우리가 파는 게 아니라 장소라서 변환할 주소가 없다.';

create table if not exists public.recommendation_item_hotels (
    item_id           uuid primary key
                      references public.recommendation_items (id) on delete cascade,
    star_rating       numeric(2,1) check (star_rating is null or star_rating between 1 and 5),
    review_score      numeric(3,1) check (review_score is null or review_score between 0 and 10),
    -- **1박 최저가(원).** 항공권의 총액과 다른 값이라 이름을 갈랐다.
    price_per_night   integer check (price_per_night is null or price_per_night > 0),
    merchant          text,                                   -- agoda | booking | trip …
    -- 애드픽 변환 결과. ⚠️ **null 이면 수익화가 안 된 노출이다** (변환 실패).
    affiliate_link_id uuid references public.affiliate_links (id) on delete set null,
    -- 예약 페이지에서 긁어온 대표 이미지.
    image_url         text
);

comment on table public.recommendation_item_hotels is
    '호텔 노출 1건. 평점은 앱이 범위를 검증해서 넣는다 — 모델이 5점 만점을 10점 칸에 '
    '넣는 일이 실제로 있었다 (parse.ts bounded 주석). '
    '⚠️ affiliate_link_id 가 null 이면 변환 실패라 수수료가 없는 노출이다.';

create table if not exists public.recommendation_item_flights (
    item_id           uuid primary key
                      references public.recommendation_items (id) on delete cascade,
    airline           text,
    -- ⚠️ 0 이 유효한 값이다 (직항). null 과 구별해야 한다.
    stops             integer check (stops is null or stops between 0 and 5),
    cabin             text,                                   -- economy | premium | business | first
    duration_minutes  integer check (duration_minutes is null or duration_minutes > 0),
    -- **1인 총액(원).** ⚠️ 웹 검색으로 얻은 예상가이지 확정 운임이 아니다.
    price_total       integer check (price_total is null or price_total > 0),
    merchant          text,                                   -- trip | myrealtrip …
    affiliate_link_id uuid references public.affiliate_links (id) on delete set null
    -- 썸네일 칸이 없다. 항공권 카드에는 이미지가 없다.
);

comment on table public.recommendation_item_flights is
    '항공권 노출 1건. stops 는 0 이 직항이므로 null 과 구별해야 한다. '
    'price_total 은 1인 총액이며 확정 운임이 아니다.';

-- ------------------------------------------- 공통에 있던 도메인 값을 내려보낸다
-- 지우고 새로 시작해도 되지만, 남아 있는 노출 기록을 굳이 버릴 이유가 없다.
-- on conflict 로 재실행에 안전하게 만든다.
--
-- 값이 하나도 없는 행은 만들지 않는다 — "상세가 없는 노출" 과 "상세가 전부 빈 노출" 은
-- 같은 뜻인데 행 수만 달라진다.
do $$
begin
    if exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'recommendation_items'
           and column_name = 'price_from'
    ) then
        insert into public.recommendation_item_hotels
            (item_id, price_per_night, merchant, affiliate_link_id, image_url)
        select id, price_from, merchant, affiliate_link_id, thumbnail_url
          from public.recommendation_items
         where domain = 'hotel'
           and coalesce(price_from::text, merchant, affiliate_link_id::text, thumbnail_url) is not null
        on conflict (item_id) do nothing;

        insert into public.recommendation_item_flights
            (item_id, price_total, merchant, affiliate_link_id)
        select id, price_from, merchant, affiliate_link_id
          from public.recommendation_items
         where domain = 'flight'
           and coalesce(price_from::text, merchant, affiliate_link_id::text) is not null
        on conflict (item_id) do nothing;

        insert into public.recommendation_item_attractions (item_id, image_url)
        select id, thumbnail_url
          from public.recommendation_items
         where domain = 'attraction'
           and thumbnail_url is not null
        on conflict (item_id) do nothing;
    end if;
end $$;

alter table public.recommendation_items
    drop column if exists price_from,
    drop column if exists merchant,
    drop column if exists thumbnail_url,
    drop column if exists affiliate_link_id;

comment on column public.recommendation_items.source_url is
    '사용자가 도착하는 원본 주소 스냅샷. 항목 단위 집계는 이름이 아니라 이 컬럼으로 한다. '
    'hotel: 예약 페이지(호텔 1곳당 고유하므로 호텔의 신원이다). '
    '⚠️ flight: 여러 항공편이 같은 노선 검색 페이지를 공유해 편의 신원이 아니다. '
    'attraction: 구글맵 주소 — 이름+도시로 결정되므로 관광지의 신원이다.';

-- 인덱스를 따로 걸지 않는다. 이 테이블들을 보는 건 전부 전체 집계(group by)라
-- 어차피 전부 읽고, 개별 조회는 item_id(기본키)로 한다. 쓰기는 노출마다 도는데
-- 읽는 쪽이 안 쓸 인덱스를 다는 건 그 경로를 느리게만 한다.

-- 서버는 service_role 키로만 접근한다 (0001 과 같다).
-- 정책 없이 RLS 만 켜두면 anon / authenticated 는 전부 차단된다.
alter table public.recommendation_item_attractions enable row level security;
alter table public.recommendation_item_hotels      enable row level security;
alter table public.recommendation_item_flights     enable row level security;

-- --------------------------------------------------------- register_click()
-- 반환 컬럼 이름이 바뀌므로 create or replace 로는 안 되고 drop 이 필요하다.
--
-- ⚠️ **drop 하면 0001 의 revoke 가 같이 사라진다.** 새로 만든 함수는 기본적으로
--    public 에 execute 권한이 있으므로 아래에서 반드시 다시 회수한다.
--
-- 위성 테이블이 생겨도 이 함수는 그대로다 — 클릭 카운터는 공통 테이블에 있다.
drop function if exists public.register_click(text);

create function public.register_click(p_click_id text)
returns table (target_url text, recommendation_id uuid, item_name text, click_count integer)
language sql
security definer
set search_path = public
as $$
    update public.recommendation_items i
       set click_count      = i.click_count + 1,
           first_clicked_at = coalesce(i.first_clicked_at, now()),
           last_clicked_at  = now()
     where i.click_id = p_click_id
    returning i.target_url, i.recommendation_id, i.item_name, i.click_count;
$$;

comment on function public.register_click(text) is
    '클릭 1회를 기록하고 리다이렉트 목적지를 돌려준다. 없는 click_id 면 0행.';

revoke execute on function public.register_click(text) from public;

-- anon / authenticated 는 Supabase 전용 롤이라 존재할 때만 회수한다 (0001 과 같다).
do $$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format(
                'revoke execute on function public.register_click(text) from %I', r
            );
        end if;
    end loop;
end $$;

-- 집계 예시 — 클릭 카운터는 공통 테이블에 있으므로 join 한다
--
--   -- 관광지: 카테고리별 CTR. 2차 호출의 "카테고리를 섞어라" 가 값을 하는지 본다
--   select a.category,
--          count(*)                                  as impressions,
--          count(*) filter (where i.click_count > 0) as clicked
--     from recommendation_items i
--     join recommendation_item_attractions a on a.item_id = i.id
--    group by 1 order by 2 desc;
--
--   -- 항공권: 직항이 경유보다 얼마나 눌리나
--   select f.stops,
--          count(*)                                  as impressions,
--          count(*) filter (where i.click_count > 0) as clicked
--     from recommendation_items i
--     join recommendation_item_flights f on f.item_id = i.id
--    group by 1 order by 1;
--
--   -- 수익화 누수 — 제휴를 타는 두 도메인만 본다 (관광지는 애초에 대상이 아니다)
--   select 'hotel' as domain, count(*) as 변환실패_노출
--     from recommendation_item_hotels where affiliate_link_id is null
--   union all
--   select 'flight', count(*)
--     from recommendation_item_flights where affiliate_link_id is null;
--
--   -- 도메인별 전체 CTR · 줄 순서의 영향 (위성 없이 공통만으로 된다)
--   select domain, position,
--          count(*)                                as impressions,
--          count(*) filter (where click_count > 0) as clicked
--     from recommendation_items group by 1, 2 order by 1, 2;

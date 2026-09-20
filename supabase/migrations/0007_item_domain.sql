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
-- **공통 테이블은 그대로 두고 도메인 테이블을 매단다.** 노출 1건은 여전히
-- recommendation_items 한 행이고, 도메인마다 다른 값만 위성 테이블 한 행으로 간다.
--
--   recommendation_items                 click_id · position · 스냅샷 · 클릭 카운터
--     ├─ recommendation_item_attractions 입장료 · 통화 · 소요시간 · 카테고리
--     ├─ recommendation_item_hotels      성급 · 평점
--     └─ recommendation_item_flights     항공사 · 경유 · 좌석 · 비행시간
--
-- 왜 공통 테이블을 셋으로 쪼개지 않았나 — click_id · position · 노출 · 클릭 카운터는
-- 세 도메인이 **똑같이** 하는 일이다. 쪼개면 그 컬럼과 인덱스가 세 벌이 되고,
-- 전체 CTR 을 보려면 union 을 써야 한다. 도메인마다 다른 것만 갈라두면 된다.
--
-- ⚠️ **이 파일을 적용한 뒤에는 0001·0002 를 다시 돌릴 수 없다.** 아래에서
--    hotel_name 을 item_name 으로 바꾸기 때문에, 그 이름을 쓰는 0001 의
--    register_click() 과 0002 의 comment 가 "컬럼이 없다" 로 실패한다.
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
-- 노출 1건당 0 또는 1행. **없어도 정상이다** — 모델이 그 값을 하나도 못 준 노출은
-- 위성 행이 안 생긴다. 그래서 집계는 항상 left join 이다.
--
-- ⚠️ **값 목록(카테고리·통화·좌석등급)에는 check 를 걸지 않는다.** 저장소가 실패를
--    삼키는 구조라(base.repository — 로깅 실패로 사용자 응답을 막지 않는다),
--    check 에 걸린 행은 경고 한 줄만 남기고 조용히 사라진다. 앱에 카테고리를
--    하나 추가한 날부터 기록이 안 남는데 아무도 모르는 게 최악이다.
--    반면 숫자 범위(성급 1~5)는 물리적으로 안 늘어나므로 걸어둔다.

create table if not exists public.recommendation_item_attractions (
    item_id            uuid primary key
                       references public.recommendation_items (id) on delete cascade,
    -- ⚠️ **현지 통화 그대로다.** 원화 환산을 하지 않는다 (0003 주석 참고).
    --    금액이 있으면 통화도 있어야 읽을 수 있다.
    admission_fee      integer check (admission_fee is null or admission_fee > 0),
    admission_currency text,
    duration_minutes   integer check (duration_minutes is null or duration_minutes > 0),
    -- 역사/문화 · 자연/공원 · 테마파크 · 거리/쇼핑 · 전망 · 미술관/박물관 · 음식/시장 · 체험
    category           text
);

comment on table public.recommendation_item_attractions is
    '관광지 노출 1건의 도메인 값. 입장료는 현지 통화 그대로이며 price_from(단위: 원)에 '
    '넣지 않는다 — 통화가 섞이면 비교할 수 없는 숫자가 된다.';

create table if not exists public.recommendation_item_hotels (
    item_id      uuid primary key
                 references public.recommendation_items (id) on delete cascade,
    star_rating  numeric(2,1) check (star_rating is null or star_rating between 1 and 5),
    review_score numeric(3,1) check (review_score is null or review_score between 0 and 10)
);

comment on table public.recommendation_item_hotels is
    '호텔 노출 1건의 도메인 값. 평점은 앱이 범위를 검증해서 넣는다 — 모델이 5점 만점을 '
    '10점 칸에 넣는 일이 실제로 있었다 (parse.ts bounded 주석).';

create table if not exists public.recommendation_item_flights (
    item_id          uuid primary key
                     references public.recommendation_items (id) on delete cascade,
    airline          text,
    -- ⚠️ 0 이 유효한 값이다 (직항). null 과 구별해야 한다.
    stops            integer check (stops is null or stops between 0 and 5),
    -- economy | premium | business | first
    cabin            text,
    duration_minutes integer check (duration_minutes is null or duration_minutes > 0)
);

comment on table public.recommendation_item_flights is
    '항공권 노출 1건의 도메인 값. stops 는 0 이 직항이므로 null 과 구별해야 한다.';

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

-- 집계 예시 — 클릭 카운터는 공통 테이블에 있으므로 left join 이다
--
--   -- 관광지: 카테고리별 CTR. 2차 호출의 "카테고리를 섞어라" 가 값을 하는지 본다
--   select a.category,
--          count(*)                                      as impressions,
--          count(*) filter (where i.click_count > 0)     as clicked
--     from recommendation_items i
--     join recommendation_item_attractions a on a.item_id = i.id
--    group by 1 order by 2 desc;
--
--   -- 관광지: 무료가 더 눌리나 (입장료는 현지 통화라 금액끼리 비교는 못 한다)
--   select a.admission_fee is null as 무료,
--          round(100.0 * count(*) filter (where i.click_count > 0) / count(*), 1) as ctr
--     from recommendation_items i
--     join recommendation_item_attractions a on a.item_id = i.id
--    group by 1;
--
--   -- 항공권: 직항이 경유보다 얼마나 눌리나
--   select f.stops,
--          count(*)                                  as impressions,
--          count(*) filter (where i.click_count > 0) as clicked
--     from recommendation_items i
--     join recommendation_item_flights f on f.item_id = i.id
--    group by 1 order by 1;
--
--   -- 도메인별 전체 CTR (위성 없이도 된다)
--   select domain,
--          count(*)                                as impressions,
--          count(*) filter (where click_count > 0) as clicked
--     from recommendation_items group by 1;

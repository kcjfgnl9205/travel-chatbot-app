-- travel-chatbot-app 초기 스키마
-- Supabase SQL Editor 에 그대로 붙여넣어 실행. 재실행해도 안전하다.
--
-- 테이블 5개. 전부 코드가 실제로 읽고 쓴다. 빈 껍데기는 두지 않는다.
--
--   users                 카카오 익명 사용자
--   messages              무엇을 요청했는가
--   recommendations       어떻게 응답했는가
--   recommendation_items  리스트 한 줄 = 노출 1건 + 클릭 카운터
--   affiliate_links       원본 주소 → 애드픽 커미션 링크 (변환 캐시 겸 호텔 신원)
--   search_cache          검색 결과 캐시 (AI/크롤링 재호출 방지)
--
-- 설계에서 알아둘 것 3가지
--
-- 1. 호텔 마스터 테이블이 없다.
--    호텔 목록을 AI/크롤링으로 매번 새로 받는데 이름으로는 "같은 호텔"을 못 묶는다.
--    '호텔 그란비아 오사카' / '그란비아 오사카' / 'Hotel Granvia Osaka' 는
--    전부 다른 값이다. 호텔 신원은 기계가 부여한 source_url 로 잡고,
--    affiliate_links 가 (partner, source_url) 유니크로 그 역할을 한다.
--    도시 목록도 DB 대신 app/services/nlu.py 상수 하나로 관리한다.
--
-- 2. 클릭은 행이 아니라 카운터다.
--    같은 줄을 10번 눌러도 recommendation_items 의 click_count 만 10이 된다.
--    노출과 클릭이 한 행에 있어서 CTR 이 join 없이 나오고,
--    리다이렉트 DB 왕복이 1회로 끝난다(register_click 함수).
--
-- 3. recommendation_items 는 스냅샷이다.
--    호텔명·가격·링크를 노출 시점 값으로 복사해둔다. 애드픽 캠페인이 바뀌거나
--    AI 가 다음번에 다른 값을 줘도 "그때 사용자가 본 화면"이 복원된다.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- users
-- 카카오는 botUserKey(채널별 익명 키)만 준다. 개인정보는 들어오지 않는다.
create table if not exists public.users (
    id             uuid primary key default gen_random_uuid(),
    kakao_user_key text not null unique,
    first_seen_at  timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    message_count  integer not null default 0
);

-- ---------------------------------------------------------------- messages
-- 사용자가 요청한 내용. raw_payload 는 오픈빌더 디버깅용.
create table if not exists public.messages (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references public.users (id) on delete set null,
    domain      text not null default 'hotel',      -- hotel | flight | ...
    block_name  text,
    utterance   text not null default '',
    parsed_city text,                                -- 파싱된 city slug. null 이면 파싱 실패
    params      jsonb not null default '{}'::jsonb,  -- 오픈빌더 action.params
    raw_payload jsonb,
    created_at  timestamptz not null default now()
);
create index if not exists messages_user_created_idx
    on public.messages (user_id, created_at desc);

-- -------------------------------------------------------- affiliate_links
-- 원본 호텔 주소 → 애드픽 커미션 링크 변환 캐시.
--
-- 애드픽 API 스펙 3가지가 전부 캐시를 요구한다.
--   · rate limit 분당 60회(linkonly=true) / 10회(false)
--     → 호텔 5건이면 미스 시 요청 1건에 5회를 쓴다
--   · 180일간 클릭 없는 링크는 삭제될 수 있음
--     → 노출마다 새 링크를 만들면 죽은 링크가 쌓인다. source_url 하나당 링크 하나
--   · p_data 는 링크 생성 시점에 박히고 이후 못 바꿈
--     → 클릭 단위가 아니라 source_url 단위 고정 코드를 쓴다.
--       애드픽 성과 데이터 API 와 조인하는 키다.
create table if not exists public.affiliate_links (
    id             uuid primary key default gen_random_uuid(),
    partner        text not null default 'adpick',
    merchant       text,                    -- 우리가 아는 제휴몰 (agoda | booking | ...)
    source_url     text not null,           -- AI/크롤링이 찾아낸 원본 호텔 주소
    affiliate_url  text,                    -- 애드픽 commissionlink
    p_data         text,                    -- 애드픽 성과 데이터 조인키
    merchant_name  text,                    -- 애드픽 cp_name       (linkonly=false)
    commission_per numeric(5,2),            -- 애드픽 commission_per (linkonly=false)
    status         text not null default 'pending',  -- pending | ok | failed | fallback
    error          text,
    raw_response   jsonb,                   -- 애드픽 API 원본 응답
    converted_at   timestamptz,
    expires_at     timestamptz,             -- null 이면 무기한 재사용
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (partner, source_url)
);
create index if not exists affiliate_links_status_idx
    on public.affiliate_links (status, expires_at);
create index if not exists affiliate_links_p_data_idx
    on public.affiliate_links (p_data);

comment on table public.affiliate_links is
    '원본 호텔 주소 → 애드픽 커미션 링크 변환 캐시. source_url 이 곧 호텔의 신원이다.';

-- ---------------------------------------------------------- search_cache
-- 검색 결과(호텔 목록) 캐시. "오사카 호텔"을 다음 사람이 물으면 여기서 바로 준다.
--
-- AI/크롤링이 붙으면 이게 비용과 속도를 동시에 좌우한다.
--   · LLM 호출은 3~10초 → 카카오 5초 제한을 그냥 넘긴다. 캐시 히트는 수십 ms
--   · LLM 호출은 건당 과금 → 같은 도시를 100명이 물어도 1회만 호출
--
-- cache_key 는 그냥 text 다. 지금은 'hotel:static:osaka::5' 지만
-- 날짜/인원 파싱이 붙으면 그 값을 키에 이어 붙이면 된다 (스키마 변경 불필요).
-- provider 이름을 키에 넣는 이유: static → ai 로 바꿨을 때 옛 결과가 나오면 안 된다.
create table if not exists public.search_cache (
    id         uuid primary key default gen_random_uuid(),
    domain     text not null default 'hotel',
    cache_key  text not null unique,
    provider   text not null,
    payload    jsonb not null,             -- 호텔 목록 전체
    item_count integer not null default 0,
    hit_count  integer not null default 0, -- 몇 번 재사용됐나 = 아낀 호출 수
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists search_cache_expires_idx
    on public.search_cache (expires_at);

comment on table public.search_cache is
    '검색 결과 캐시. 만료된 행은 조회 시 무시되며, 주기적으로 지워도 무방하다.';

-- ------------------------------------------------------- recommendations
-- "이 요청에 이렇게 응답했다" 1건
create table if not exists public.recommendations (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references public.users (id) on delete set null,
    message_id uuid references public.messages (id) on delete set null,
    domain     text not null default 'hotel',
    city_slug  text,
    guests     integer,
    provider   text not null default 'static',   -- static | ai | crawler
    item_count integer not null default 0,
    cache_hit  boolean not null default false,   -- search_cache 에서 왔나
    latency_ms integer,                          -- 카카오 5초 예산 대비 여유 추적
    created_at timestamptz not null default now()
);
create index if not exists recommendations_user_created_idx
    on public.recommendations (user_id, created_at desc);

-- -------------------------------------------------- recommendation_items
-- listCard 한 줄 = 이 테이블 1행. 노출과 클릭을 함께 들고 있다.
create table if not exists public.recommendation_items (
    id                uuid primary key default gen_random_uuid(),
    recommendation_id uuid not null references public.recommendations (id) on delete cascade,
    affiliate_link_id uuid references public.affiliate_links (id) on delete set null,
    position          integer not null default 0,   -- 줄 순서 (0부터)
    click_id          text not null unique,         -- /r/{click_id}

    -- 노출 시점 스냅샷
    hotel_name    text not null,
    price_from    integer,
    merchant      text,
    thumbnail_url text,
    source_url    text,                             -- 호텔 신원. 집계는 이걸로 한다
    target_url    text not null,                    -- 302 목적지 (커미션 링크)

    -- 클릭 카운터
    click_count      integer not null default 0,
    first_clicked_at timestamptz,
    last_clicked_at  timestamptz,

    created_at timestamptz not null default now()
);
create index if not exists recommendation_items_rec_idx
    on public.recommendation_items (recommendation_id, position);
create index if not exists recommendation_items_source_url_idx
    on public.recommendation_items (source_url);
create index if not exists recommendation_items_clicked_idx
    on public.recommendation_items (click_count) where click_count > 0;

comment on column public.recommendation_items.source_url is
    '원본 호텔 주소 스냅샷. 호텔 단위 집계는 hotel_name 이 아니라 이 컬럼으로 한다 '
    '(AI 가 이름 표기를 매번 다르게 주기 때문).';

-- ------------------------------------------------------- register_click()
-- PostgREST 는 `set x = x + 1` 같은 컬럼 표현식 업데이트를 지원하지 않는다.
-- 앱에서 읽고 더해서 쓰면 동시 클릭에 카운트가 유실되므로 함수로 만든다.
-- 조회 + 증가 + 목적지 반환을 한 번에 처리해 DB 왕복도 1회로 줄인다.
create or replace function public.register_click(p_click_id text)
returns table (target_url text, recommendation_id uuid, hotel_name text, click_count integer)
language sql
security definer
set search_path = public
as $$
    update public.recommendation_items i
       set click_count      = i.click_count + 1,
           first_clicked_at = coalesce(i.first_clicked_at, now()),
           last_clicked_at  = now()
     where i.click_id = p_click_id
    returning i.target_url, i.recommendation_id, i.hotel_name, i.click_count;
$$;

comment on function public.register_click(text) is
    '클릭 1회를 기록하고 리다이렉트 목적지를 돌려준다. 없는 click_id 면 0행.';

-- ------------------------------------------------------------------- 권한
-- 서버는 service_role 키로만 접근한다.
-- 정책 없이 RLS 만 켜두면 anon / authenticated 는 전부 차단된다.
alter table public.users                enable row level security;
alter table public.messages             enable row level security;
alter table public.affiliate_links      enable row level security;
alter table public.search_cache         enable row level security;
alter table public.recommendations      enable row level security;
alter table public.recommendation_items enable row level security;

revoke execute on function public.register_click(text) from public;

-- anon / authenticated 는 Supabase 전용 롤이라 존재할 때만 회수한다.
-- (그래야 이 파일이 순수 Postgres 에서도 그대로 돈다 — 로컬 검증용)
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

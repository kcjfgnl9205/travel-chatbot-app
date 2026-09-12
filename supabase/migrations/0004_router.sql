-- 라우터 재설계 (0003 다음에 실행. 재실행해도 안전하다)
--
-- 오픈빌더에서 시나리오 블록·엔티티를 전부 지웠다. 봇을 멘션한 모든 발화가 폴백으로
-- 떨어지므로 서버 진입점은 `POST /api/v1/kakao/router` 하나뿐이다. 그 구조에 맞춰
-- **지역 마스터**와 **검색 결과 저장소**가 새로 생긴다.
--
--   places          지역 마스터 (오사카 · 도톤보리 · 서울)
--   place_aliases   별칭 → 지역. 캐시 적중률이 전부 여기서 결정된다
--   search_results  검색 결과 저장 겸 캐시 겸 single-flight 락
--   intent_cache    같은 문장 재파싱 방지
--
-- 0001~0003 의 테이블은 그대로 쓴다. 바뀐 건 "무엇으로 캐시를 가르는가" 뿐이고,
-- 노출·클릭 추적(recommendations / recommendation_items / affiliate_links)은
-- 라우터가 생겨도 하는 일이 같다.
--
-- ⚠️ search_cache(0001)는 이제 코드가 읽지 않는다. 지우지는 않았다 —
--    롤백하면 다시 필요하고, 만료 행만 남아 있어 비용이 없다.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- places
-- 지역 마스터. **미리 채우지 않는다. 쓰면서 자란다.**
--
-- 사전(city-table.ts)에 있는 도시는 거기서, 없는 곳은 모델에게 표준명을 물어
-- 여기에 등록한다. 그래서 "도톤보리"·"해운대" 같은 세부 지역도 자기 행을 갖는다.
create table if not exists public.places (
    id             bigint generated always as identity primary key,
    canonical_name text not null,                       -- 오사카
    -- 검색 질의·통계에 쓰는 영문 슬러그. 스펙에는 없지만 필요하다 —
    -- provider 가 도시를 slug 로 받고, 0001 의 city_slug 컬럼과 같은 값이어야
    -- 라우터 이전/이후의 집계가 이어진다.
    slug           text not null,                       -- osaka
    country_code   text,                                -- 'JP'. 별도 테이블은 아직 불필요
    kind           text not null default 'city'
                   check (kind in ('city', 'area', 'landmark')),
    -- 대표 공항 IATA. 항공권 검색 품질이 여기 달려 있어 지역에 같이 둔다.
    iata           text,
    parent_id      bigint references public.places (id),  -- 도톤보리 → 오사카
    created_at     timestamptz not null default now()
);
create unique index if not exists places_slug_kind_idx on public.places (slug, kind);

comment on table public.places is
    '지역 마스터. 미리 채우지 않고 질의를 받을 때마다 자란다. 세부 지역(도톤보리)은 '
    'parent_id 로 도시에 매단다 — 별칭으로 합치면 "도톤보리 주변" 이라는 정보가 사라진다.';

-- ---------------------------------------------------------- place_aliases
-- 별칭 → 지역. **캐시 적중률의 핵심이다.**
-- "오사카" / "osaka" / "오사카시" 가 같은 place_id 로 모이지 않으면 같은 지역을
-- 물을 때마다 AI 검색이 새로 돈다.
create table if not exists public.place_aliases (
    alias      text primary key,                        -- 정규화 키: 공백 제거 + 소문자
    place_id   bigint not null references public.places (id) on delete cascade,
    created_at timestamptz not null default now()
);
create index if not exists place_aliases_place_idx on public.place_aliases (place_id);

-- --------------------------------------------------------- search_results
-- 검색 결과 저장 겸 캐시 겸 **동시 호출 방지 락**.
--
-- 행 하나가 20건을 통째로 들고 있고 카드는 5건씩 잘라 보낸다. 세 사람이 동시에
-- "오사카 호텔" 을 쳐도 AI 가 한 번만 돌아야 하므로, 먼저 pending 을 꽂은 쪽만
-- 검색을 수행한다 (Redis 락 없이 Postgres 만으로 된다).
--
--   insert ... on conflict (cache_key) do nothing returning cache_key
--
-- 날짜·인원은 캐시 키에 넣지 않는다. 지역(+항공권은 노선·왕복여부)만으로 가른다.
-- 대신 **반영하지 않았다는 사실을 카드 아래 안내에 반드시 적는다** — 고지 없이
-- 날짜를 무시한 결과를 주면 사용자는 속았다고 느낀다.
create table if not exists public.search_results (
    cache_key     text primary key,                     -- 'hotel:123', 'flight:1>2:rt'
    kind          text not null check (kind in ('hotel', 'flight', 'attraction')),
    place_id      bigint references public.places (id),
    from_place_id bigint references public.places (id), -- 항공권 전용
    to_place_id   bigint references public.places (id),
    trip_type     text check (trip_type in ('rt', 'ow')),
    status        text not null default 'pending'
                  check (status in ('pending', 'ready', 'failed')),
    items         jsonb not null default '[]'::jsonb,   -- 최대 20건
    item_count    int not null default 0,
    -- 카드 머리글·"더 보기" 버튼을 다시 만들려면 지역명이 필요하다. 더보기 요청은
    -- cache_key 만 들고 오므로(발화에 지역이 없다) 여기 없으면 AI 를 다시 불러야 한다.
    meta          jsonb not null default '{}'::jsonb,
    error         text,
    fetched_at    timestamptz,
    expires_at    timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists search_results_expires_idx on public.search_results (expires_at);
create index if not exists search_results_kind_place_idx on public.search_results (kind, place_id);

comment on column public.search_results.status is
    'pending: 누군가 검색 중(먼저 꽂은 쪽만 수행). ready: 결과 있음. failed: 실패 — '
    '짧은 TTL 로 재시도를 허용한다.';
comment on column public.search_results.expires_at is
    '⚠️ 만료된 행은 지우지 않는다. AI 검색이 실패했을 때 "예전에 찾아둔 정보" 로 '
    '보여주는 편이 아무것도 못 주는 것보다 낫다.';

-- ----------------------------------------------------------- intent_cache
-- 같은 문장 재파싱 방지. 단톡방은 같은 말이 반복된다.
create table if not exists public.intent_cache (
    utterance_hash text primary key,                    -- 정규화 문장의 sha256
    result         jsonb not null,                      -- ParsedIntent
    created_at     timestamptz not null default now(),
    expires_at     timestamptz not null
);
create index if not exists intent_cache_expires_idx on public.intent_cache (expires_at);

-- ------------------------------------------------------------------- 권한
-- 서버는 service_role 키로만 접근한다.
-- 정책 없이 RLS 만 켜두면 anon / authenticated 는 전부 차단된다.
alter table public.places         enable row level security;
alter table public.place_aliases  enable row level security;
alter table public.search_results enable row level security;
alter table public.intent_cache   enable row level security;

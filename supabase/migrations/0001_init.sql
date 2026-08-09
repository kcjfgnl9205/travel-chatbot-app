-- travel-chatbot-app 초기 스키마
-- Supabase SQL Editor에 그대로 붙여넣어 실행하거나, supabase CLI로 마이그레이션 적용.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- users
-- 카카오는 botUserKey(채널별 익명 키)만 준다. 개인정보 없음.
create table if not exists public.users (
    id           uuid primary key default gen_random_uuid(),
    kakao_user_key text not null unique,
    first_seen_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    message_count integer not null default 0
);

-- ---------------------------------------------------------------- cities
create table if not exists public.cities (
    id         bigserial primary key,
    slug       text not null unique,          -- 'osaka'
    name_ko    text not null,                 -- '오사카'
    country_ko text not null default '',      -- '일본'
    aliases    text[] not null default '{}',  -- ['오사카','osaka','大阪']
    is_active  boolean not null default true,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- messages
-- 사용자가 요청한 내용 로그. raw_payload는 오픈빌더 디버깅용.
create table if not exists public.messages (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references public.users (id) on delete set null,
    domain       text not null default 'hotel',      -- hotel | flight | ...
    block_name   text,
    utterance    text not null default '',
    parsed_city  text,                                -- 파싱된 city slug
    params       jsonb not null default '{}'::jsonb,  -- 오픈빌더 action.params
    raw_payload  jsonb,
    created_at   timestamptz not null default now()
);
create index if not exists messages_user_created_idx
    on public.messages (user_id, created_at desc);

-- ---------------------------------------------------------------- hotels
create table if not exists public.hotels (
    id            uuid primary key default gen_random_uuid(),
    external_id   text unique,               -- 시드/외부 소스 식별자 (upsert 키)
    name          text not null,
    city_slug     text not null,
    address       text,
    star_rating   numeric(2,1),
    review_score  numeric(3,1),
    price_from    integer,                   -- 1박 최저가 (KRW)
    currency      text not null default 'KRW',
    thumbnail_url text,
    description   text,
    tags          text[] not null default '{}',   -- ['도톤보리','조식포함']
    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists hotels_city_active_idx
    on public.hotels (city_slug, is_active);

-- ---------------------------------------------------------- hotel_offers
-- 호텔 × 제휴사. 같은 호텔에 아고다/부킹 링크가 각각 있을 수 있다.
create table if not exists public.hotel_offers (
    id           uuid primary key default gen_random_uuid(),
    hotel_id     uuid not null references public.hotels (id) on delete cascade,
    partner      text not null default 'adpick',   -- adpick
    merchant     text,                             -- agoda | booking | ...
    campaign_id  text,                             -- 애드픽 캠페인 ID
    target_url   text not null,                    -- 애드픽 딥링크 (최종 이동지)
    priority     integer not null default 0,       -- 클수록 우선
    is_active    boolean not null default true,
    created_at   timestamptz not null default now()
);
create index if not exists hotel_offers_hotel_idx
    on public.hotel_offers (hotel_id, is_active, priority desc);

-- ------------------------------------------------------- recommendations
-- "이 요청에 이렇게 응답했다" 1건
create table if not exists public.recommendations (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references public.users (id) on delete set null,
    message_id  uuid references public.messages (id) on delete set null,
    domain      text not null default 'hotel',
    city_slug   text,
    check_in    date,
    check_out   date,
    guests      integer,
    provider    text not null default 'static',   -- static | ai | crawler
    item_count  integer not null default 0,
    created_at  timestamptz not null default now()
);
create index if not exists recommendations_user_created_idx
    on public.recommendations (user_id, created_at desc);

-- -------------------------------------------------- recommendation_items
-- 응답에 실제로 담긴 호텔들. 링크는 그 시점 스냅샷으로 보관.
create table if not exists public.recommendation_items (
    id                uuid primary key default gen_random_uuid(),
    recommendation_id uuid not null references public.recommendations (id) on delete cascade,
    hotel_id          uuid references public.hotels (id) on delete set null,
    hotel_offer_id    uuid references public.hotel_offers (id) on delete set null,
    position          integer not null default 0,
    click_id          text not null unique,     -- /r/{click_id}
    hotel_name        text not null,
    price_from        integer,
    target_url        text not null,            -- 리다이렉트될 애드픽 링크 스냅샷
    created_at        timestamptz not null default now()
);
create index if not exists recommendation_items_rec_idx
    on public.recommendation_items (recommendation_id, position);

-- ---------------------------------------------------------------- clicks
-- 사용자가 무엇을 골랐는가 = 이 테이블
create table if not exists public.clicks (
    id                     uuid primary key default gen_random_uuid(),
    click_id               text not null,
    recommendation_item_id uuid references public.recommendation_items (id) on delete set null,
    recommendation_id      uuid references public.recommendations (id) on delete set null,
    user_id                uuid references public.users (id) on delete set null,
    hotel_id               uuid references public.hotels (id) on delete set null,
    target_url             text,
    user_agent             text,
    referer                text,
    ip_hash                text,                -- 원본 IP는 저장하지 않음
    created_at             timestamptz not null default now()
);
create index if not exists clicks_click_id_idx on public.clicks (click_id);
create index if not exists clicks_user_created_idx
    on public.clicks (user_id, created_at desc);

-- ------------------------------------------------------------ conversions
-- Phase 4: 애드픽 리포트/포스트백으로 실제 예약 전환을 click_id에 매칭
create table if not exists public.conversions (
    id          uuid primary key default gen_random_uuid(),
    click_id    text,
    click_row_id uuid references public.clicks (id) on delete set null,
    partner     text not null default 'adpick',
    status      text not null default 'pending',  -- pending | approved | rejected
    reward      numeric(12,2),
    currency    text not null default 'KRW',
    raw_payload jsonb,
    occurred_at timestamptz,
    created_at  timestamptz not null default now()
);
create index if not exists conversions_click_id_idx on public.conversions (click_id);

-- ------------------------------------------------------------------- RLS
-- 서버가 service_role 키로만 접근한다. 정책 없이 RLS만 켜두면 anon/authenticated 차단.
alter table public.users                enable row level security;
alter table public.cities               enable row level security;
alter table public.messages             enable row level security;
alter table public.hotels               enable row level security;
alter table public.hotel_offers         enable row level security;
alter table public.recommendations      enable row level security;
alter table public.recommendation_items enable row level security;
alter table public.clicks               enable row level security;
alter table public.conversions          enable row level security;

-- ------------------------------------------------------------ seed: cities
insert into public.cities (slug, name_ko, country_ko, aliases) values
    ('osaka',    '오사카',  '일본', array['오사카','오오사카','osaka','大阪']),
    ('tokyo',    '도쿄',    '일본', array['도쿄','동경','tokyo','東京']),
    ('fukuoka',  '후쿠오카','일본', array['후쿠오카','후쿠','fukuoka','福岡'])
on conflict (slug) do nothing;

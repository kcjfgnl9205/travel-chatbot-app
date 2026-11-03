-- =============================================================================
-- MySQL 스키마 (OCI MySQL HeatWave). Supabase 마이그레이션 0001~0015 의 **최종 상태**다.
--
-- 배포 때 db/migrate.js 가 자동으로 적용하고 schema_migrations 에 기록한다.
-- ⚠️ **한 번 적용된 파일은 고치지 않는다.** 바꿀 게 있으면 0002_*.sql 을 새로 만든다 —
--    러너는 파일 이름으로 적용 여부를 가리므로, 고친 내용은 운영에 영영 안 들어간다.
--    (그래서 러너가 내용 해시를 같이 남겨두고, 달라지면 경고한다.)
--
-- Postgres 와 다르게 정한 것 (코드가 이 규칙에 기대고 있다):
--
-- 1. **시간은 전부 UTC 의 DATETIME(3)** 이다. MySQL 에는 timestamptz 가 없다.
--    앱은 접속마다 `time_zone = '+00:00'` 을 걸고(mysql.service.ts), 쿼리 안에서
--    현재 시각이 필요하면 now() 가 아니라 UTC_TIMESTAMP(3) 을 쓴다.
--    ⚠️ 밀리초(3)를 빼면 search_results.updated_at 낙관적 락이 영영 안 맞는다.
--
-- 2. **콜레이션은 utf8mb4_0900_bin** (대소문자·악센트 구분). 기본값(ai_ci)이면
--    'OSAKA' = 'osaka', 'café' = 'cafe' 가 같아져서 kakao_user_key 가 다른 두 사람이
--    한 행으로 합쳐질 수 있다. Postgres 와 같은 "글자 그대로 비교" 로 맞춘다.
--
-- 3. **UUID 는 앱이 만든다** (crypto.randomUUID). MySQL 에는 RETURNING 이 없어서
--    insert 후 id 를 돌려받으려면 미리 정해두는 게 가장 싸다. DEFAULT (uuid()) 는
--    손으로 넣을 때를 위한 예비다.
--
-- 4. **긴 URL 의 유니크는 해시 컬럼으로 건다.** TEXT 에는 전체 길이 유니크 인덱스를
--    걸 수 없고, 앞부분만 거는 prefix 인덱스는 "같은 호텔" 판정을 틀리게 만든다.
--
-- 5. RLS 는 없다. 이 DB 는 VCN 안에서 앱 서버만 접속한다.
--
-- 6. `rank` 는 MySQL 8 의 예약어다. 쿼리에서 반드시 백틱으로 감싼다.
-- =============================================================================

-- ---------------------------------------------------------------- 사용자·발화
create table if not exists users (
    id             char(36)     not null default (uuid()),
    kakao_user_key varchar(255) not null,
    first_seen_at  datetime(3)  not null default current_timestamp(3),
    last_seen_at   datetime(3)  not null default current_timestamp(3),
    message_count  int          not null default 0,
    primary key (id),
    unique key users_kakao_user_key_key (kakao_user_key)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

create table if not exists messages (
    id          char(36)     not null default (uuid()),
    user_id     char(36),
    domain      varchar(32)  not null default 'hotel',
    block_name  varchar(255),
    utterance   text         not null default (''),
    parsed_city varchar(255),
    params      json         not null default (json_object()),
    raw_payload json,
    created_at  datetime(3)  not null default current_timestamp(3),
    primary key (id),
    key messages_user_created_idx (user_id, created_at desc),
    constraint messages_user_id_fkey
        foreign key (user_id) references users (id) on delete set null
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

-- ---------------------------------------------------------------- 제휴 링크
create table if not exists affiliate_links (
    id              char(36)      not null default (uuid()),
    partner         varchar(32)   not null default 'adpick',
    merchant        varchar(64),
    source_url      text          not null,
    -- (partner, source_url) 유니크를 대신한다. 위 규칙 4 참고.
    source_url_hash binary(32)    generated always as (unhex(sha2(source_url, 256))) stored,
    affiliate_url   text,
    p_data          varchar(255),
    merchant_name   varchar(255),
    commission_per  decimal(5, 2),
    status          varchar(16)   not null default 'pending',
    error           text,
    raw_response    json,
    converted_at    datetime(3),
    expires_at      datetime(3),
    created_at      datetime(3)   not null default current_timestamp(3),
    updated_at      datetime(3)   not null default current_timestamp(3),
    primary key (id),
    unique key affiliate_links_partner_source_key (partner, source_url_hash),
    key affiliate_links_source_hash_idx (source_url_hash),
    key affiliate_links_status_idx (status, expires_at),
    key affiliate_links_p_data_idx (p_data)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

-- ---------------------------------------------------------------- 노출·클릭
create table if not exists recommendations (
    id         char(36)     not null default (uuid()),
    user_id    char(36),
    message_id char(36),
    domain     varchar(32)  not null default 'hotel',
    city_slug  varchar(255),
    guests     int,
    provider   varchar(32)  not null default 'static',
    item_count int          not null default 0,
    cache_hit  boolean      not null default false,
    latency_ms int,
    created_at datetime(3)  not null default current_timestamp(3),
    primary key (id),
    key recommendations_user_created_idx (user_id, created_at desc),
    constraint recommendations_user_id_fkey
        foreign key (user_id) references users (id) on delete set null,
    constraint recommendations_message_id_fkey
        foreign key (message_id) references messages (id) on delete set null
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

create table if not exists recommendation_items (
    id                char(36)     not null default (uuid()),
    recommendation_id char(36)     not null,
    domain            varchar(32),
    position          int          not null default 0,
    click_id          varchar(64)  not null,
    item_name         text         not null,
    source_url        text,
    target_url        text         not null,
    price             int,
    merchant          varchar(64),
    image_url         text,
    affiliate_link_id char(36),
    click_count       int          not null default 0,
    first_clicked_at  datetime(3),
    last_clicked_at   datetime(3),
    created_at        datetime(3)  not null default current_timestamp(3),
    primary key (id),
    unique key recommendation_items_click_id_key (click_id),
    key recommendation_items_rec_idx (recommendation_id, position),
    key recommendation_items_source_url_idx (source_url(255)),
    key recommendation_items_clicked_idx (click_count),
    key recommendation_items_domain_idx (domain, created_at desc),
    key recommendation_items_unconverted_idx (domain, affiliate_link_id),
    constraint recommendation_items_domain_check
        check (domain is null or domain in ('hotel', 'flight', 'attraction')),
    constraint recommendation_items_price_check check (price is null or price > 0),
    constraint recommendation_items_recommendation_id_fkey
        foreign key (recommendation_id) references recommendations (id) on delete cascade,
    constraint recommendation_items_affiliate_link_id_fkey
        foreign key (affiliate_link_id) references affiliate_links (id) on delete set null
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

-- ---------------------------------------------------------------- 지역
create table if not exists places (
    id             bigint       not null auto_increment,
    canonical_name varchar(255) not null,
    slug           varchar(255) not null,
    country_code   varchar(8),
    kind           varchar(16)  not null default 'city',
    iata           varchar(8),
    parent_id      bigint,
    `rank`         int,
    blurb          varchar(255),
    created_at     datetime(3)  not null default current_timestamp(3),
    primary key (id),
    unique key places_slug_kind_idx (slug, kind),
    key places_parent_idx (parent_id),
    key places_parent_rank_idx (parent_id, `rank`),
    constraint places_kind_check check (kind in ('country', 'city', 'area', 'landmark')),
    constraint places_parent_id_fkey foreign key (parent_id) references places (id)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

create table if not exists place_aliases (
    alias      varchar(255) not null,
    place_id   bigint       not null,
    created_at datetime(3)  not null default current_timestamp(3),
    primary key (alias),
    key place_aliases_place_idx (place_id),
    constraint place_aliases_place_id_fkey
        foreign key (place_id) references places (id) on delete cascade
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

-- ---------------------------------------------------------------- 검색 결과·캐시
create table if not exists search_results (
    cache_key     varchar(512) not null,
    kind          varchar(16)  not null,
    place_id      bigint,
    from_place_id bigint,
    to_place_id   bigint,
    trip_type     varchar(4),
    status        varchar(16)  not null default 'pending',
    items         json         not null default (json_array()),
    item_count    int          not null default 0,
    meta          json         not null default (json_object()),
    error         text,
    fetched_at    datetime(3),
    expires_at    datetime(3),
    created_at    datetime(3)  not null default current_timestamp(3),
    updated_at    datetime(3)  not null default current_timestamp(3),
    primary key (cache_key),
    key search_results_expires_idx (expires_at),
    key search_results_kind_place_idx (kind, place_id),
    constraint search_results_kind_check check (kind in ('hotel', 'flight', 'attraction')),
    constraint search_results_trip_type_check check (trip_type is null or trip_type in ('rt', 'ow')),
    constraint search_results_status_check check (status in ('pending', 'ready', 'failed')),
    constraint search_results_place_id_fkey foreign key (place_id) references places (id),
    constraint search_results_from_place_id_fkey foreign key (from_place_id) references places (id),
    constraint search_results_to_place_id_fkey foreign key (to_place_id) references places (id)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

create table if not exists intent_cache (
    utterance_hash char(64)    not null,
    result         json        not null,
    created_at     datetime(3) not null default current_timestamp(3),
    expires_at     datetime(3) not null,
    primary key (utterance_hash),
    key intent_cache_expires_idx (expires_at)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

-- ---------------------------------------------------------------- 관광지
create table if not exists attractions (
    id               bigint       not null auto_increment,
    city_id          bigint       not null,
    name             varchar(255) not null,
    name_en          varchar(255),
    area             varchar(255),
    image_url        text,
    image_source     text,
    `rank`           int          not null default 0,
    source           varchar(16)  not null default 'manual',
    impression_count int          not null default 0,
    click_count      int          not null default 0,
    first_clicked_at datetime(3),
    last_clicked_at  datetime(3),
    created_at       datetime(3)  not null default current_timestamp(3),
    updated_at       datetime(3)  not null default current_timestamp(3),
    primary key (id),
    unique key attractions_city_name_key (city_id, name),
    key attractions_city_rank_idx (city_id, `rank`, name),
    key attractions_source_idx (source, city_id),
    key attractions_click_count_idx (click_count desc),
    constraint attractions_source_check check (source in ('manual', 'ai')),
    constraint attractions_city_id_fkey
        foreign key (city_id) references places (id) on delete cascade
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_0900_bin;

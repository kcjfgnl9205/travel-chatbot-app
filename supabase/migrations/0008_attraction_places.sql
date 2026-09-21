-- 관광지 목록의 출처를 구글 Places 로 바꾼다 (0007 다음. 재실행해도 안전하다)
--
-- 0007 까지 관광지는 **모델이 웹을 검색해서** 목록을 만들었다. 그 방식의 실패는
-- 조용했다 — 폐관한 곳이나 아예 없는 곳이 섞여도 사용자가 현장에 가서야 안다.
-- 이제 목록은 구글에서 오고, 모델은 **순서만** 정한다.
--
--   구글 Places   어떤 곳이 있나 · 이름 · 평점 · 위치      → 존재가 보장된다
--   모델          그중 뭘 먼저 보여줄까                   → 한국인 여행자 관점
--   위키미디어    사진                                    → 주소가 죽지 않는다
--
-- **저장이 두 층으로 갈린다. 이게 이 마이그레이션의 핵심이다.**
--
--   attraction_places   place_id + 순서          영구   ← 구글이 영구 저장을 허용하는 값
--   search_results      이름 · 평점 · 사진 · 위치  30일   ← 나머지 구글 콘텐츠
--
-- ⚠️ 구글 약관은 place_id 외의 콘텐츠를 오래 보관하는 걸 제한한다. 그래서 캐시가
--    만료되면 **실제로 지운다** — "만료돼도 보여주기"(0004) 를 관광지에서만 끈 이유다.
--    목록을 다시 만들 필요는 없다. place_id 가 남아 있으니 구글에 다시 물으면 채워진다.

-- ------------------------------------------------------- 도시별 관광지 목록
-- **호텔에는 없는 마스터 테이블이다.** 0001 이 "호텔 마스터를 두지 않는다" 고 한 건
-- 이름으로는 같은 호텔을 묶을 수 없어서였는데, 관광지는 place_id 라는 안정적인 신원이
-- 생겼으므로 사정이 다르다. '오사카성' 과 '오사카 성' 이 같은 행이 된다.
create table if not exists public.attraction_places (
    place_id      text primary key,                      -- 구글 신원. ChIJ…
    city_id       bigint not null references public.places (id) on delete cascade,
    -- 모델이 정한 추천 순서(0이 첫째). **캐시가 비었을 때 이 순서로 되살린다** —
    -- 그래서 모델을 다시 부르지 않아도 된다.
    rank          integer not null default 0,
    first_seen_at timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists attraction_places_city_rank_idx
    on public.attraction_places (city_id, rank);

comment on table public.attraction_places is
    '도시별 관광지 목록. **구글 place_id 와 추천 순서만 영구 보관한다** — 이름·평점 '
    '같은 구글 콘텐츠는 약관상 장기 보관이 제한되므로 search_results 30일 캐시에만 둔다. '
    '캐시가 비면 여기 있는 place_id 로 구글에 다시 물어 채운다(모델 재호출 불필요).';

comment on column public.attraction_places.rank is
    '모델이 정한 추천 순서(0이 첫째). 구글 순서는 인기·거리 기준이라 "처음 가는 '
    '한국인에게 뭘 먼저 보여줄까" 를 못 한다 — 그 판단만 모델이 한다.';

-- ------------------------------------------------------- 도시별 갱신 시각
-- 배치가 "마지막 갱신이 오래된 도시" 를 고르는 기준이다.
--
-- ⚠️ **캐시 TTL(30일)보다 짧은 주기로 돌아야 한다.** 만료된 뒤에 갱신하면 그 도시의
--    첫 질문이 다시 대기를 타므로, 미리 채워두는 의미가 없어진다. 28일을 권한다.
alter table public.places
    add column if not exists attractions_refreshed_at timestamptz;

create index if not exists places_attractions_refreshed_idx
    on public.places (attractions_refreshed_at);

comment on column public.places.attractions_refreshed_at is
    '관광지 목록을 구글에서 마지막으로 받아온 시각. null 이면 아직 채운 적 없다 — '
    '배치가 먼저 집는다. 캐시 TTL 보다 짧은 주기로 갱신해야 사용자가 기다리지 않는다.';

-- --------------------------------------------- 노출 스냅샷에서 모델이 주던 칸을 걷는다
-- 입장료·소요시간은 **아예 수집하지 않기로 했다.** 구글이 주지 않고 모델은 지어낸다 —
-- 틀린 가격은 없는 가격보다 나쁘다. 그 칸들을 남겨두면 영원히 null 인 칸이 된다.
--
-- free 도 같이 간다. 입장료가 없으니 "무료인가" 를 판정할 근거가 없다.
-- description(한 줄 소개)도 모델이 쓰던 값이라 뺀다.
alter table public.recommendation_item_attractions
    drop column if exists admission_fee,
    drop column if exists admission_currency,
    drop column if exists duration_minutes,
    drop column if exists free,
    drop column if exists description;

-- 남는 건 구글 신원과 우리가 쓰는 표시값뿐이다.
alter table public.recommendation_item_attractions
    add column if not exists place_id text;

create index if not exists recommendation_item_attractions_place_idx
    on public.recommendation_item_attractions (place_id);

comment on table public.recommendation_item_attractions is
    '관광지 노출 1건. **평점·리뷰수·주소를 여기 남기지 않는다** — 구글 콘텐츠라 영구 '
    '보관이 제한된다. 남기는 건 place_id(영구 저장 허용)와 우리가 고른 카테고리·위치·사진뿐. '
    '"그때 평점이 몇이었나" 는 30일 캐시가 살아 있는 동안만 알 수 있다.';

comment on column public.recommendation_item_attractions.place_id is
    '구글 장소 신원. **관광지 단위 집계는 이 칸으로 한다** — 이름은 표기가 흔들리지만 '
    '이 값은 같은 장소에 항상 같다. attraction_places 와 조인된다.';

-- 관광지를 우리가 직접 관리한다 (0008 다음. 재실행해도 안전하다)
--
-- 0008 까지 관광지는 **구글이 목록을 주고, 모델이 순서를 정하고, 위키미디어가 사진을
-- 붙였다.** 그 구조를 통째로 걷어낸다. 남의 콘텐츠를 빌려 쓰는 대가가 셋이었다 —
--
--   요금    `rating` 을 요청하는 순간 Text Search Enterprise SKU 가 되는데 그 무료
--           한도는 월 1,000회뿐이다. 도시 하나에 6회씩 나가서 여유가 거의 없었다.
--   약관    이름·평점은 장기 보관이 제한돼 30일 캐시에만 둬야 했고, 카드에는
--           'Google Maps' 출처를 밝혀야 했다(밝히지 않고 있었다).
--   저작권  위키미디어 사진은 대부분 저작자 표시가 필요한데, listCard 한 줄에는
--           링크가 하나뿐이고 그 자리는 지도가 쓴다.
--
-- **이제 우리가 넣은 것만 보여준다.** 보관 제한도, 출처 표시도, API 요금도 없다.
-- 대신 목록을 사람이 채워야 한다 — 그게 이 판의 유일한 비용이다.

-- ------------------------------------------------------------------ 관광지 마스터
-- **0008 의 attraction_places 를 대신한다.** 그 테이블은 구글 place_id 만 들고
-- 나머지는 캐시에 두는 구조였는데, 이제 보관을 제한하는 약관이 없으므로 한 곳에
-- 다 넣는다. 카드에 찍히는 값이 전부 여기 있다.
create table if not exists public.attractions (
    id         bigserial primary key,
    city_id    bigint not null references public.places (id) on delete cascade,
    -- 카드 제목. 사용자가 보는 그 이름이다.
    name       text not null,
    -- 도시 안에서의 위치 (주오구 · 우메다). 카드 설명 한 줄이 이 값이다.
    -- ⚠️ 도시 이름을 다시 쓰지 않는다 — 사용자는 이미 그 도시를 물어봤다.
    area       text,
    -- 카드 썸네일. **https 여야 한다** — 카카오는 http 이미지를 그리지 않는다.
    image_url  text,
    -- 노출 순서(0이 첫째). 사람이 정한다. 같은 값이면 이름순으로 갈린다.
    rank       integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 목록 조회가 이 인덱스 하나로 끝난다 (도시 → 순서).
create index if not exists attractions_city_rank_idx
    on public.attractions (city_id, rank, name);

-- ⚠️ **같은 도시에 같은 이름을 두 번 넣지 못하게 한다.** 관리 화면에서 실수로 두 번
--    저장하면 카드에 같은 줄이 두 번 나가는데, 도메인의 dedupe 는 id 로 판정하므로
--    그걸 못 잡는다. DB 가 막는 게 확실하다.
create unique index if not exists attractions_city_name_key
    on public.attractions (city_id, name);

comment on table public.attractions is
    '도시별 관광지 목록. **우리가 직접 채운다** — 구글 Places 도 모델도 부르지 않는다. '
    '남의 콘텐츠가 아니므로 보관 기간 제한이 없고 출처 표시 의무도 없다.';

comment on column public.attractions.rank is
    '노출 순서(0이 첫째). 사람이 정한다. 0008 까지는 모델이 정하던 값이다.';

comment on column public.attractions.area is
    '도시 안에서의 위치 (주오구 · 우메다). 카드 설명 한 줄이 이 값 하나다 — '
    '평점·카테고리를 함께 찍던 자리인데 둘 다 구글 콘텐츠라 같이 걷어냈다.';

-- 서버는 service_role 키로만 접근한다 (0001 과 같다).
-- ⚠️ **새 테이블을 만들 때마다 이 줄을 같이 써야 한다.** 0008 에서 한 번 빠뜨렸다.
alter table public.attractions enable row level security;

-- ------------------------------------------------------- 구글 시절의 잔재를 걷는다
-- place_id 만 들고 있던 마스터. 이제 attractions 가 그 역할을 하고, 저장할 구글
-- 신원도 없다.
drop table if exists public.attraction_places;

-- 배치가 "마지막으로 구글에서 받아온 시각" 을 보던 칸. 배치 자체가 없어졌다 —
-- 목록이 DB 에 있으므로 미리 채워둘 것이 없다.
drop index if exists public.places_attractions_refreshed_idx;
alter table public.places
    drop column if exists attractions_refreshed_at;

-- ------------------------------------------------------- 노출 스냅샷
-- 관광지 단위 집계의 기준이 place_id 에서 attraction_id 로 옮겨간다.
--
-- ⚠️ **on delete set null 이다.** 관리 화면에서 관광지를 지웠다고 "그때 이걸 보여줬다"
--    는 기록까지 사라지면 안 된다. 이름은 recommendation_items.label 에 남는다.
alter table public.recommendation_item_attractions
    drop column if exists place_id,
    -- 카테고리는 구글 타입에서 온 값이었다(관광명소·역사/문화…). 이제 안 받는다.
    drop column if exists category;

alter table public.recommendation_item_attractions
    add column if not exists attraction_id bigint
        references public.attractions (id) on delete set null;

create index if not exists recommendation_item_attractions_attraction_idx
    on public.recommendation_item_attractions (attraction_id);

comment on table public.recommendation_item_attractions is
    '관광지 노출 1건. 판매처·제휴링크·원화 가격 칸이 없는 것이 이 도메인의 정체다 — '
    '관광지는 우리가 파는 게 아니라 장소라서 변환할 주소가 없다. '
    '평점·카테고리 칸도 없다 — 구글을 끊으면서 그 값을 아예 받지 않게 됐다.';

comment on column public.recommendation_item_attractions.attraction_id is
    '어느 관광지를 보여줬는가 (attractions.id). **관광지 단위 집계는 이 칸으로 한다** — '
    '이름은 관리 화면에서 바뀔 수 있지만 이 값은 그대로다. '
    '관광지가 삭제되면 null 이 된다(노출 기록 자체는 남는다).';

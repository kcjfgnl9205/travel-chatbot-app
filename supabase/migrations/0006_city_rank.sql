-- 나라의 대표 도시에 순서와 한 줄 설명을 붙인다 (0005 다음. 재실행해도 안전하다)
--
-- "일본 어느 도시의 호텔을 찾을까요?" 카드가 도시 이름만 나열하면 고르기 어렵다.
-- 그 도시가 어디인지("신주쿠 · 시부야") 한 줄이 붙으면 처음 가는 사람도 고른다.
--
--   rank   나라 안에서의 인기 순서. 카드에 보여줄 순서다 (등록 순이 아니라)
--   blurb  대표 지역 두 곳. 12자 안쪽 — listCard 줄 설명이 40자이고 짧을수록 읽힌다
--
-- 도시 자체는 여러 나라에 걸치지 않으므로 places 행에 그대로 둔다. 별도 테이블을
-- 만들면 "그 도시의 순위" 하나 때문에 조인이 생긴다.

alter table public.places add column if not exists rank  int;
alter table public.places add column if not exists blurb text;

comment on column public.places.rank is
    '나라 안에서의 인기 순서(1이 가장 인기). 도시 고르기 카드의 정렬 기준이다. '
    'null 이면 뒤로 간다 — 되묻기 목록에 올라온 적 없는 도시다.';
comment on column public.places.blurb is
    '카드 줄 설명. 대표 지역 두 곳("신주쿠 · 시부야"). 12자 안쪽.';

create index if not exists places_parent_rank_idx on public.places (parent_id, rank);

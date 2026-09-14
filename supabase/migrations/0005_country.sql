-- 나라를 지역으로 인정한다 (0004 다음에 실행. 재실행해도 안전하다)
--
-- "베트남 여행지 추천해줘" 처럼 **나라**를 말하는 질문이 흔하다. 예전에는 그걸
-- "지역 없음" 으로 떨어뜨려 `어느 지역을 찾으세요? 예) 오사카` 로 되물었는데,
-- 베트남을 물은 사람에게 일본 도시를 권하는 꼴이었다.
--
-- 나라도 places 의 한 행으로 두고, 그 나라의 도시를 **parent_id 로 매단다.**
-- 그러면 "베트남 → 다낭·하노이·호치민…" 목록이 테이블에 남아 두 번째부터는
-- 모델 없이 즉답이 된다. 세부 지역(도톤보리 → 오사카)과 같은 구조를 한 단 더 쓰는 것뿐이다.
--
--   베트남(country) ─┬─ 다낭(city) ─── (그 안의 area/landmark)
--                   ├─ 하노이(city)
--                   └─ 호치민(city)

alter table public.places drop constraint if exists places_kind_check;
alter table public.places
    add constraint places_kind_check
    check (kind in ('country', 'city', 'area', 'landmark'));

comment on column public.places.kind is
    'country: 나라. 검색 대상이 아니라 **도시를 되묻는 자리**다. '
    'city: 도시. area/landmark: 도시 안의 구역·명소(도톤보리). '
    'parent_id 로 country → city → area 가 이어진다.';

create index if not exists places_parent_idx on public.places (parent_id);

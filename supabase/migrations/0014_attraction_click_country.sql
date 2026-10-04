-- 클릭 리다이렉트가 나라를 알게 한다 (0013 다음. 재실행해도 안전하다)
--
-- 국내 관광지를 카카오맵으로 보내려면 "이 도시가 한국인가" 를 알아야 하는데,
-- 그 재료가 **두 군데에 엇갈려 있었다.**
--
--   사전(city-table.ts) country   서울·부산 등 21곳    ← 사전에 있는 도시만
--   DB(places.country_code)       춘천·목포 등 새 도시  ← 모델이 등록한 도시만
--
-- 엇갈린 이유는 등록 경로가 둘이기 때문이다. 사전 경로(`draftFromTable`)는
-- `countryCode: null` 로 넣고, 모델 경로는 모델이 준 값을 채운다
-- ([places.service.ts](../../src/modules/places/places.service.ts)). 그래서 지금
-- `places` 116행이 전부 null 인데, 그건 컬럼이 안 쓰여서가 아니라 **116곳이 전부
-- 씨앗(사전)으로 들어왔기 때문**이다. 새 도시가 생기면 거기에만 값이 붙는다.
--
-- 앱이 사전만 보면 새 도시를 놓치고, DB 만 보면 기존 116곳을 놓친다. **둘 다 봐야
-- 한다.** 사전은 앱이 이미 0ms 로 읽으므로, 모자란 쪽인 DB 값을 여기서 같이 준다.
--
-- ⚠️ **왕복이 늘지 않는다.** 이 함수는 이미 `places` 를 조인하고 있어서 컬럼 하나를
--    더 select 할 뿐이다. 사용자가 302 를 기다리는 경로라 이게 중요하다.

-- ⚠️ **`create or replace` 로는 안 된다.** RETURNS TABLE 의 컬럼이 바뀌면 Postgres 가
--    "cannot change return type of existing function" 으로 거부한다. 먼저 지워야 한다.
drop function if exists public.register_attraction_click(bigint);

create function public.register_attraction_click(p_id bigint)
returns table (attraction_name text, city_name text, country_code text, clicks integer)
language sql
security definer
set search_path = public
as $$
    with bumped as (
        update public.attractions a
           set click_count      = a.click_count + 1,
               first_clicked_at = coalesce(a.first_clicked_at, now()),
               last_clicked_at  = now()
         where a.id = p_id
        returning a.name, a.city_id, a.click_count
    )
    select b.name,
           btrim(p.canonical_name || coalesce(' ' || pp.canonical_name, '')),
           -- ⚠️ **부모를 폴백으로 둔다.** 세부 지역(해운대 → 부산)은 자기 country_code 가
           --    비어 있는 경우가 많은데, 그때 부모 도시의 값이 맞다. 앱의 사전 조회는
           --    city_name 이 "해운대 부산" 으로 붙어 와서 전체 일치가 깨지므로,
           --    국내 세부 지역을 구해주는 건 사실상 이 한 줄이다.
           coalesce(p.country_code, pp.country_code),
           b.click_count
      from bumped b
      join public.places p on p.id = b.city_id
      left join public.places pp
             on pp.id = p.parent_id and pp.id <> p.id;
$$;

comment on function public.register_attraction_click(bigint) is
    '클릭 1회를 기록하고 지도 링크를 만들 재료(이름·도시·나라)를 돌려준다. 없는 id 면 0행. '
    '⚠️ URL 조립은 앱(common/maps-url.ts)이 한다 — 규칙을 두 군데 두지 않는다. '
    'country_code 는 국내/해외를 갈라 카카오맵과 구글맵 중 하나를 고르는 데 쓴다. '
    '⚠️ **null 이 흔하다**(사전으로 등록된 도시는 안 채워진다). null 은 "해외" 가 아니라 '
    '"모름" 이므로, 앱은 사전(city-table.ts)도 같이 본다.';

-- ------------------------------------------------------------------------ 권한
-- ⚠️ **drop 했으므로 권한이 초기화됐다.** 0012 는 `create or replace` 라 기존 권한이
--    유지됐지만, 여기서는 함수가 새로 만들어진 것이라 public 에 execute 가 붙어 있다.
--    반드시 회수한다 — 서버는 service_role 키로만 접근한다 (0001 과 같다).
revoke execute on function public.register_attraction_click(bigint) from public;

-- anon / authenticated 는 Supabase 전용 롤이라 존재할 때만 회수한다 (0012 와 같다).
do $$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format(
                'revoke execute on function public.register_attraction_click(bigint) from %I', r
            );
        end if;
    end loop;
end $$;

-- 확인 — 사전에 없는 국내 도시가 실제로 값을 들고 있는지 본다
--
--   select p.slug, p.canonical_name, p.country_code, count(a.id) as 관광지
--     from places p left join attractions a on a.city_id = p.id
--    where p.kind = 'city' and p.country_code is not null
--    group by 1, 2, 3
--    order by p.id;

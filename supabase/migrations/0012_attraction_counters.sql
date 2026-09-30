-- 관광지 노출을 행이 아니라 카운터로 센다 (0011 다음. 재실행해도 안전하다)
--
-- **0009 가 전제를 바꿨는데 이 자리를 안 고쳤다.**
--
-- `recommendation_items` 가 노출마다 한 행씩 쌓이는 이유는 0001 에 적혀 있다 —
-- 호텔·항공권 목록은 AI/크롤링이 매번 새로 받아오고 `search_results` 는 갱신되면
-- 덮어써지므로, "그때 사용자가 본 값" 을 복사해두지 않으면 영영 복원이 안 된다.
--
-- 그런데 0009 에서 관광지가 `attractions` 로 넘어오면서 **복원할 것이 없어졌다.**
-- 그 테이블은 우리가 소유한 영구 행이고 아무것도 덮어쓰지 않는다. 세 도메인이 같은
-- 렌더러를 타서 관광지만 따로 손대지 않았을 뿐이다.
--
-- 관광지에서만 성립하는 사실 셋 —
--
--   1. `click_id` 가 아무것도 안 나른다. 호텔·항공권은 이 값이 애드픽 subid 로
--      **링크에 박혀서** 노출마다 달라야 성과 조인이 되는데(applySubid),
--      관광지는 `monetized=false` 라 subid 를 붙이지 않는다. 조회 키일 뿐이다.
--   2. 목적지가 결정값이다. `mapsUrl(name, cityName)` — 이름과 도시로 정해진다.
--      스냅샷해 둘 이유가 없고, 이름을 고치면 오히려 새 값이 맞다.
--   3. `position` 이 관광지의 함수다. 순서는 `attractions.rank` 로 고정돼 있어서
--      후쿠오카의 그 곳은 **항상** 같은 줄에 나간다. 줄 순서별 CTR 이 안 나온다.
--
-- 그래서 관광지는 노출 1건 = 카운터 +1 이면 충분하다. 요청당 쓰기가 6행에서
-- 1행(`recommendations`)으로 줄고, `attractions` 는 도시당 스무 곳에서 안 자란다.
--
-- **호텔·항공권은 그대로다.** 위 셋이 하나도 성립하지 않는다.
--
-- ⚠️ **누적값이다.** 기간별로 쪼개지지 않고 누가 눌렀는지도 안 남는다. 지금 필요한
--    것은 "어느 관광지가 많이 눌리나" 하나뿐이라 그걸로 충분하다.

-- ------------------------------------------------------------------ 카운터
alter table public.attractions
    add column if not exists impression_count integer not null default 0,
    add column if not exists click_count      integer not null default 0,
    add column if not exists first_clicked_at timestamptz,
    add column if not exists last_clicked_at  timestamptz;

comment on column public.attractions.impression_count is
    '카드에 나간 누적 횟수. 클릭률의 **분모**다 — 이 값 없이 click_count 만 보면 '
    '"100번 눌린 곳" 이 인기가 많은 건지 그냥 100번 노출된 건지 알 수 없다.';

comment on column public.attractions.click_count is
    '누적 클릭. `/a/{id}` 리다이렉트가 올린다. 기간별로는 쪼개지지 않는다.';

-- 인기순 조회 하나가 이 인덱스로 끝난다. 관리 API 가 쓴다.
create index if not exists attractions_click_count_idx
    on public.attractions (click_count desc);

-- --------------------------------------------- 지금까지의 노출 기록을 카운터로 옮긴다
-- 행을 버리기 전에 합계는 살린다. **`to_regclass` 가 곧 재실행 방지다** — 아래에서
-- 위성 테이블을 지우므로 두 번째 실행에는 이 블록이 통째로 건너뛰어진다.
--
-- ⚠️ `least`/`greatest` 는 Postgres 에서 null 을 무시한다. 처음 옮길 때
--    a.first_clicked_at 이 null 인 게 정상이라 이 성질에 기대고 있다.
do $$
begin
    if to_regclass('public.recommendation_item_attractions') is not null then
        with rolled as (
            select ra.attraction_id              as id,
                   count(*)                      as impressions,
                   coalesce(sum(i.click_count), 0) as clicks,
                   min(i.first_clicked_at)       as first_at,
                   max(i.last_clicked_at)        as last_at
              from public.recommendation_item_attractions ra
              join public.recommendation_items i on i.id = ra.item_id
             where ra.attraction_id is not null
             group by ra.attraction_id
        )
        update public.attractions a
           set impression_count = a.impression_count + r.impressions,
               click_count      = a.click_count + r.clicks,
               first_clicked_at = least(a.first_clicked_at, r.first_at),
               last_clicked_at  = greatest(a.last_clicked_at, r.last_at)
          from rolled r
         where a.id = r.id;
    end if;
end $$;

-- 위성 테이블을 걷는다. 남아 있던 칸(area·image_url)은 `attractions` 의 사본이었고,
-- attraction_id 가 하던 집계는 위에서 카운터로 옮겼다.
drop table if exists public.recommendation_item_attractions;

-- ⚠️ **`recommendation_items` 의 옛 관광지 행은 그대로 둔다.** 합계는 위에서 옮겼고,
--    지우는 건 되돌릴 수 없어서 기본 동작으로 삼지 않는다. 새 행은 더 안 생긴다.
--    정리하고 싶으면 이 줄을 직접 실행한다 (자식 행이 없으므로 그냥 지워진다):
--
--      delete from public.recommendation_items where domain = 'attraction';

-- ------------------------------------------------------------------- 노출 집계
-- 한 번의 카드 노출에 관광지 스무 곳이 나간다. 건별로 UPDATE 를 스무 번 보내면
-- 그게 곧 요청 지연이라, 배열 하나로 받아 한 문장에 끝낸다.
--
-- PostgREST 로는 `set x = x + 1` 같은 표현식 업데이트를 못 해서 함수가 필요하다
-- (0001 의 register_click 과 같은 사정).
create or replace function public.register_attraction_impressions(p_ids bigint[])
returns integer
language sql
security definer
set search_path = public
as $$
    with bumped as (
        update public.attractions a
           set impression_count = a.impression_count + 1
         where a.id = any(p_ids)
        returning a.id
    )
    select count(*)::integer from bumped;
$$;

comment on function public.register_attraction_impressions(bigint[]) is
    '카드에 나간 관광지들의 노출 수를 한 번에 올린다. 돌려주는 값은 실제로 올린 행 수 — '
    '건넨 수와 다르면 그 사이에 지워진 관광지가 있다는 뜻이다.';

-- ------------------------------------------------------------------- 클릭 집계
-- `/a/{id}` 가 부른다. 조회·증가·목적지 재료를 **왕복 한 번**에 끝낸다
-- (사용자가 302 를 기다리는 경로다).
--
-- ⚠️ **목적지 URL 을 여기서 만들지 않는다.** 구글맵 주소 조립은 앱의
--    `common/maps-url.ts` 한 곳에만 둔다 — SQL 에 한 벌 더 두면 둘이 어긋나는 날이
--    오고, 그때 어느 쪽이 맞는지 아무도 모른다. 여기서는 재료(이름·도시)만 준다.
--
-- city_name 은 앱의 `searchName()` 과 같은 규칙으로 맞춘다: 세부 지역이면 부모 도시를
-- 붙인다("도톤보리 오사카"). 노출 때 만든 링크와 같은 주소가 나와야 한다.
create or replace function public.register_attraction_click(p_id bigint)
returns table (attraction_name text, city_name text, clicks integer)
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
           b.click_count
      from bumped b
      join public.places p on p.id = b.city_id
      left join public.places pp
             on pp.id = p.parent_id and pp.id <> p.id;
$$;

comment on function public.register_attraction_click(bigint) is
    '클릭 1회를 기록하고 지도 링크를 만들 재료(이름·도시)를 돌려준다. 없는 id 면 0행. '
    '⚠️ URL 조립은 앱(common/maps-url.ts)이 한다 — 규칙을 두 군데 두지 않는다.';

-- ------------------------------------------------------------------------ 권한
-- 서버는 service_role 키로만 접근한다 (0001 과 같다).
-- create or replace 는 기존 권한을 유지하지만, 처음 만들어질 때는 public 에
-- execute 가 붙으므로 반드시 회수한다.
revoke execute on function public.register_attraction_impressions(bigint[]) from public;
revoke execute on function public.register_attraction_click(bigint) from public;

-- anon / authenticated 는 Supabase 전용 롤이라 존재할 때만 회수한다 (0001 과 같다).
do $$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format(
                'revoke execute on function public.register_attraction_impressions(bigint[]) from %I', r
            );
            execute format(
                'revoke execute on function public.register_attraction_click(bigint) from %I', r
            );
        end if;
    end loop;
end $$;

-- 집계 예시 — 조인이 없다. 그게 이 판의 요점이다
--
--   -- 많이 눌린 관광지 (기획 4)
--   select name, area, impression_count, click_count,
--          round(100.0 * click_count / nullif(impression_count, 0), 1) as ctr
--     from attractions
--    where impression_count > 0
--    order by click_count desc
--    limit 20;
--
--   -- 노출은 많은데 안 눌리는 곳. rank 를 내리거나 사진을 바꿀 후보다
--   select name, area, impression_count, click_count
--     from attractions
--    where impression_count >= 50 and click_count = 0
--    order by impression_count desc;
--
--   -- 호텔·항공권은 여전히 노출 행으로 센다 (스냅샷이 필요한 도메인이다)
--   select domain, count(*) as impressions,
--          count(*) filter (where click_count > 0) as clicked
--     from recommendation_items
--    where domain in ('hotel', 'flight')
--    group by domain;

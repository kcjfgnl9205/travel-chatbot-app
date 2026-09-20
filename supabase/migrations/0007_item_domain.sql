-- 노출 스냅샷을 도메인별로 가른다 (0006 다음에 실행. 재실행해도 안전하다)
--
-- 0002·0003 은 "새 테이블이 없다" 로 버텼다. 도메인이 늘어도 하는 일이 같았기
-- 때문인데, **남길 값은 같지 않았다.** 관광지 입장료·항공편명·호텔 평점은 담을
-- 칸이 없어서 카드에만 찍히고 버려졌다.
--
-- 왜 search_results 로는 안 되나 — 거기에 도메인 객체가 통째로 있지만 그건
-- **캐시라서 갱신되면 덮어써진다.** 같은 cache_key 를 다시 검색하면 이전 값이
-- 사라지므로 "그때 사용자가 본 입장료" 는 영영 복원되지 않는다. 0001 이 이
-- 테이블을 스냅샷으로 만든 이유가 정확히 그것이다.
--
-- 왜 컬럼을 늘리지 않고 jsonb 한 칸인가 —
--   · 도메인별 컬럼은 나머지 두 도메인에서 항상 null 이 된다. thumbnail_url 이
--     이미 그 모양이다(항공권·관광지는 항상 null).
--   · 도메인별 테이블은 노출 1건당 INSERT 가 2번이 된다. 이 테이블에 쓰는 코드는
--     **카카오 5초 예산 안에서 돈다** (rows.service 가 응답 전에 await 한다).
--     왕복 하나가 곧 사용자 대기 시간이다.
--   · 집계가 굳으면 그때 그 필드만 컬럼으로 승격하면 된다.
--
-- ⚠️ **이 파일을 적용한 뒤에는 0001·0002 를 다시 돌릴 수 없다.** 아래에서
--    hotel_name 을 item_name 으로 바꾸기 때문에, 그 이름을 쓰는 0001 의
--    register_click() 과 0002 의 comment 가 "컬럼이 없다" 로 실패한다.
--    컬럼 개명이면 어느 마이그레이션에서든 생기는 일이고, 순서대로 한 번씩
--    적용하는 정상 경로(빈 DB → 0001…0007)는 그대로 돈다. 전체 재적용이
--    필요하면 빈 DB 에서 하라.
--
-- ⚠️ item_meta 는 **읽을 계획이 있는 값만** 담는다. 채우기만 하고 아무도 안 보는
--    칸은 나중에 증가를 멈춰도 알 수가 없다 — 틀린 계측은 없는 계측보다 나쁘다.

-- ------------------------------------------------- domain / item_meta
alter table public.recommendation_items
    add column if not exists domain    text,
    add column if not exists item_meta jsonb not null default '{}'::jsonb;

-- 도메인은 부모가 이미 안다. 조인 없이 보려고 복사해두는 값이다 —
-- recommendations.domain 은 행이 만들어진 뒤 바뀌지 않으므로 어긋날 일이 없다.
update public.recommendation_items i
   set domain = r.domain
  from public.recommendations r
 where r.id = i.recommendation_id
   and i.domain is null;

-- not null 로 묶지 않는다. 이 파일이 새 코드보다 먼저 돌 수 있고, 그때 들어오는
-- 행은 domain 이 비는데 그것 때문에 노출 기록이 통째로 실패하면 안 된다.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'recommendation_items_domain_check'
    ) then
        alter table public.recommendation_items
            add constraint recommendation_items_domain_check
            check (domain is null or domain in ('hotel', 'flight', 'attraction'));
    end if;
end $$;

create index if not exists recommendation_items_domain_idx
    on public.recommendation_items (domain, created_at desc);

comment on column public.recommendation_items.domain is
    'hotel | flight | attraction. recommendations.domain 의 사본이다 — 조인 없이 '
    '도메인별로 보려고 둔다. 부모가 진실이고 이 값은 행이 만들어질 때 한 번 정해진다.';

comment on column public.recommendation_items.item_meta is
    '도메인마다 다른 노출 시점 스냅샷. 공통 칸(price_from 등)에 안 들어가는 값만 담는다. '
    'attraction: admissionFee · admissionCurrency · durationMinutes · category. '
    'hotel: starRating · reviewScore. '
    'flight: airline · stops · cabin · durationMinutes. '
    '⚠️ 키는 앱의 필드명(camelCase)을 그대로 쓴다 — 도메인 타입과 대조하기 쉬워야 한다.';

-- ------------------------------------------------ hotel_name → item_name
-- 0002 는 이 칸에 항공편명이 들어가는 걸 알면서도 이름을 그대로 뒀다. 그때는
-- 개명만을 위한 마이그레이션이 위험 대비 실익이 없었기 때문이고, 이제 어차피
-- 이 테이블을 건드리는 김에 바꾼다 (DB.md 도 같은 제안을 적어뒀다).
do $$
begin
    if exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'recommendation_items'
           and column_name = 'hotel_name'
    ) and not exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'recommendation_items'
           and column_name = 'item_name'
    ) then
        alter table public.recommendation_items rename column hotel_name to item_name;
    end if;
end $$;

comment on column public.recommendation_items.item_name is
    '노출된 항목의 이름 스냅샷. hotel: 호텔명. flight: 항공사+편명+구간 '
    '("대한항공 KE723 ICN→KIX"). attraction: 관광지명. '
    '⚠️ 항목 단위 집계는 이 칸이 아니라 source_url 로 한다 — AI 가 표기를 매번 다르게 준다.';

-- --------------------------------------------------------- register_click()
-- 반환 컬럼 이름이 바뀌므로 create or replace 로는 안 되고 drop 이 필요하다.
--
-- ⚠️ **drop 하면 0001 의 revoke 가 같이 사라진다.** 새로 만든 함수는 기본적으로
--    public 에 execute 권한이 있으므로 아래에서 반드시 다시 회수한다.
drop function if exists public.register_click(text);

create function public.register_click(p_click_id text)
returns table (target_url text, recommendation_id uuid, item_name text, click_count integer)
language sql
security definer
set search_path = public
as $$
    update public.recommendation_items i
       set click_count      = i.click_count + 1,
           first_clicked_at = coalesce(i.first_clicked_at, now()),
           last_clicked_at  = now()
     where i.click_id = p_click_id
    returning i.target_url, i.recommendation_id, i.item_name, i.click_count;
$$;

comment on function public.register_click(text) is
    '클릭 1회를 기록하고 리다이렉트 목적지를 돌려준다. 없는 click_id 면 0행.';

revoke execute on function public.register_click(text) from public;

-- anon / authenticated 는 Supabase 전용 롤이라 존재할 때만 회수한다 (0001 과 같다).
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

-- 집계 예시 — 도메인이 행에 있으니 조인이 없다
--
--   -- 관광지: 카테고리별 CTR. 2차 호출의 "카테고리를 섞어라" 가 값을 하는지 본다
--   select item_meta->>'category' as category,
--          count(*)                                    as impressions,
--          sum(case when click_count > 0 then 1 end)   as clicked
--     from recommendation_items
--    where domain = 'attraction'
--    group by 1 order by 2 desc;
--
--   -- 관광지: 무료가 더 눌리나 (입장료는 현지 통화라 금액 비교는 못 한다)
--   select (item_meta->>'admissionFee') is null as 무료,
--          round(100.0 * sum(case when click_count > 0 then 1 end) / count(*), 1) as ctr
--     from recommendation_items
--    where domain = 'attraction'
--    group by 1;
--
--   -- 항공권: 직항이 경유보다 얼마나 눌리나
--   select (item_meta->>'stops')::int as 경유횟수,
--          count(*)                   as impressions,
--          sum(case when click_count > 0 then 1 end) as clicked
--     from recommendation_items
--    where domain = 'flight'
--    group by 1 order by 1;

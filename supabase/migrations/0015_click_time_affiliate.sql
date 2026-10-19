-- 제휴 변환을 노출 시점에서 클릭 시점으로 옮긴다 (0014 다음. 재실행해도 안전하다)
--
-- **카카오 5초 예산에서 애드픽을 들어낸다.**
--
-- 지금까지는 카드를 만들면서 줄마다 애드픽을 불렀다. 0004 에서 링크에 날짜·인원이
-- 박히면서 `affiliate_links` 캐시 적중률이 떨어졌고(발화마다 주소가 다르다), 미스면
-- **요청 경로에서 최대 2초를 기다렸다.** 파서 모델까지 겹치면 5초를 넘기고, 그때
-- 사용자가 받는 건 오류도 도움말도 아닌 **침묵**이다 — 카카오가 응답을 버린다.
--
-- 눌리는 줄은 많아야 하나인데 세 줄을 전부 변환하던 것도 같이 사라진다. 애드픽
-- 분당 60회 제한에도 그만큼 여유가 생긴다.
--
--   노출: target_url 에 **원본 주소**를 적는다. 변환 없음. 0ms
--   클릭: /r/{clickId} 가 그 한 줄만 변환하고 302. 못 받으면 원본으로 보낸다
--
-- ⚠️ **그래서 register_click() 이 source_url 과 merchant 를 같이 줘야 한다.**
--    변환의 입력(원본 주소)과, 그 줄이 애드픽을 타는지(merchant → adpickCarries)를
--    리다이렉트가 알아야 하기 때문이다. DB 왕복은 여전히 **한 번**이다.
--
-- ⚠️ **배포 순서를 안 탄다.** 이 함수가 아직 옛 모양이면 source_url 이 안 오고,
--    리다이렉트는 저장된 target_url 로 그냥 보낸다 (0014 까지의 동작). 코드를
--    먼저 올리든 SQL 을 먼저 돌리든 링크는 죽지 않는다.
--
-- 되돌리려면 0007 의 함수 정의를 다시 실행하면 된다. 컬럼은 건드리지 않았다.

-- --------------------------------------------------------- register_click()
-- 반환 컬럼이 늘어나므로 create or replace 로는 안 되고 drop 이 필요하다.
--
-- ⚠️ **drop 하면 0007 의 revoke 가 같이 사라진다.** 새로 만든 함수는 기본적으로
--    public 에 execute 권한이 있으므로 아래에서 반드시 다시 회수한다.
drop function if exists public.register_click(text);

create function public.register_click(p_click_id text)
returns table (
    target_url        text,
    source_url        text,
    merchant          text,
    recommendation_id uuid,
    item_name         text,
    click_count       integer
)
language sql
security definer
set search_path = public
as $$
    update public.recommendation_items i
       set click_count      = i.click_count + 1,
           first_clicked_at = coalesce(i.first_clicked_at, now()),
           last_clicked_at  = now()
     where i.click_id = p_click_id
    returning i.target_url, i.source_url, i.merchant,
              i.recommendation_id, i.item_name, i.click_count;
$$;

comment on function public.register_click(text) is
    '클릭 1회를 기록하고 리다이렉트 재료(원본 주소·판매처·폴백 목적지)를 돌려준다. 없는 click_id 면 0행.';

revoke execute on function public.register_click(text) from public;

-- anon / authenticated 는 Supabase 전용 롤이라 존재할 때만 회수한다 (0007 과 같다).
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

-- 확인 — 클릭된 줄이 변환 링크를 달았는지 본다
--
--   select i.domain,
--          count(*)                                           as 클릭된_줄,
--          count(*) filter (where i.affiliate_link_id is not null) as 변환됨
--     from recommendation_items i
--    where i.click_count > 0
--    group by 1;
--
-- ⚠️ **노출된 줄에는 affiliate_link_id 가 없다** — 변환이 클릭 시점으로 갔으므로
--    누르지 않은 줄은 영원히 null 이다. 그게 맞는 값이다. 변환 실패를 세려면
--    위처럼 `click_count > 0` 을 반드시 걸어라.

-- 빈 도시를 모델이 채운다 (0009 다음. 재실행해도 안전하다)
--
-- 0009 는 관광지를 전부 사람이 넣는 구조였다. 깨끗하지만 **안 넣은 도시가 빈손**이고,
-- 도시 237곳을 손으로 채우는 건 현실적이지 않다. 그래서 아무도 안 넣은 도시에
-- 한해서 모델이 초안을 만들어 넣는다.
--
-- ⚠️ **이건 0008 이전으로 돌아가는 게 아니다.** 그때는 모델 출력이 사용자에게 바로
--    갔고, 폐관한 곳이 섞여도 아무도 몰랐다. 지금은 DB 라는 중간 단계가 있어서
--    **틀린 것을 찾아 고칠 자리가 있다** — 그러려면 무엇이 모델에서 왔는지
--    알아야 하고, 그게 이 컬럼이다.

alter table public.attractions
    add column if not exists source text not null default 'manual'
        check (source in ('manual', 'ai'));

-- 운영이 "모델이 넣은 것만" 훑어볼 때 쓴다. 도시별로 보게 되므로 city_id 를 앞에 둔다.
create index if not exists attractions_source_idx
    on public.attractions (source, city_id);

comment on column public.attractions.source is
    'manual = 사람이 관리 화면에서 넣음 · ai = 빈 도시라 모델이 채움. '
    '**카드에서는 둘을 구별하지 않는다** — 노출 여부가 아니라 나중에 검수할 대상을 '
    '찾기 위한 표식이다. 모델은 폐관한 곳이나 없는 곳을 그럴듯하게 섞는데, '
    '이 컬럼이 없으면 어느 줄을 의심해야 하는지 알 수가 없다.';

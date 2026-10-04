# 관광지 일괄 등록 — 다른 AI 에게 시키는 프롬프트

> 도메인 설명은 [ATTRACTION.md](../ATTRACTION.md), 테이블은 [DB.md](../DB.md).
> 여기는 **`attractions` 를 한 번에 채우는 일회성 작업 자료**다. 코드가 읽지 않는다.

`attractions` 는 원래 두 경로로 채워진다 — 관리 화면에서 사람이 넣거나(`source='manual'`),
아무도 안 넣은 도시를 모델이 그 자리에서 채우거나(`source='ai'`,
[attraction-backfill.ts](../../src/modules/attraction/attraction-backfill.ts)).

**이 폴더는 세 번째 길이다.** 런타임 백필은 [의도적으로 웹 검색을 안 쓴다](../../src/modules/attraction/attraction-backfill.ts) —
도시당 $0.05~0.1 대 $0.002 라서. 대신 **최근에 생긴 곳을 모른다.** 미리 한 번
제대로 채워두면 그 약점이 사라지고, 사용자가 첫 질문에서 콜백을 기다릴 일도 없다.

---

## 파일

| 파일 | 무엇 |
|---|---|
| `prompt.txt` | **이것 하나를 통째로 복사해 다른 AI 에게 붙인다.** 116곳 전부가 들어 있다 |
| `cities.txt` | 대상 도시 116곳. `places` 에서 직접 뽑았다 (`slug / 한국어명`) |
| `fill-images.sh` | 5단계. 전 도시의 빈 사진을 위키미디어로 채운다 (무료·모델 안 부름) |
| `prompt-name-en.txt` | 6단계. 사진을 못 찾은 줄의 영문명을 채운다 (아래 참고) |
| `name-en-targets.tsv` | 그 대상 351건. DB 에서 뽑았다 (`id / 도시 / 이름`) |

### 끊기면 "계속" 이라고만 하면 된다

116곳 × 최대 20곳 = 2,300행쯤이라 **한 응답에 다 안 들어간다.** 그래서 프롬프트에
끊는 규칙을 박아뒀다 — 목록 순서대로 쓰고, 도시 블록 중간에서는 멈추지 않고,
멈출 때 이 줄을 남긴다:

```sql
-- STOP: fukuoka 까지. 다음은 oita 부터.
```

받은 SQL 을 붙여 넣고 `계속` 이라고 치면 그다음 도시부터 이어진다. 전부 끝나면
`-- DONE: 116개 도시 완료` 가 나온다.

⚠️ **도시 블록 중간에서 잘린 SQL 을 그대로 붙이지 마라.** 문법 오류로 그 문장
하나가 통째로 실패한다. `-- STOP:` 줄이 안 보이면 마지막 `on conflict ... ;` 까지만
잘라 쓰고, 그 뒤 반쪽짜리 블록은 버린 다음 그 도시부터 다시 받아라.

---

## 순서 — 이대로 해야 한다

### 1. 코드를 먼저 배포한다

⚠️ **`cities.txt` 에 `singapore` 가 들어 있는데, 지금 `places` 에는 없다.**

싱가포르는 나라이면서 도시인데 `kind` 는 값이 하나뿐이고, 라우터는 `country` 를
보면 [검색을 아예 안 탄다](../../src/modules/kakao/router.controller.ts). 그래서
`COUNTRY_TABLE` 에서 뺐다 ([country-table.ts](../../src/modules/places/country-table.ts) 의
⚠️ 주석). **그 변경이 배포되기 전에 아래 2번을 돌리면 `sg` / `country` 행이 도로 생긴다.**

### 2. 씨앗 도시를 심는다

```bash
curl -X POST https://bot.nolmoa.com/api/v1/catalog/seed -H "X-Debug-Token: $DEBUG_TOKEN"
```

`stored` 가 0 이면 DB 자격증명 문제다 — `seeded` 는 메모리 폴백으로도 올라간다
([catalog.service.ts](../../src/modules/catalog/catalog.service.ts) 의 ⚠️).

기본값은 아시아 112곳([`SEED_CITY_COUNT`](../../src/modules/catalog/catalog.service.ts))이다.
유럽·미주까지 원하면 `CITY_TABLE.length` 로 바꾸고 `cities.txt` 도 다시 뽑아라.

### 3. 프롬프트를 돌려 SQL 을 받는다

`prompt.txt` 를 통째로 붙이고, 끊기면 `계속`. 받은 SQL 은 **눈으로 한 번 훑고**
Supabase SQL Editor 에 붙인다. 특히 `name` 칸에 설명이 섞였는지 본다 —
실제로 이런 게 들어온 적이 있다:

```
무앙보란(아노타이) 제외 — 대신: 소운 팍깟 궁전 박물관
시암의 박물관: 뮤지엄 오브 시암
```

### 4. 빈 도시가 없는지 센다

⚠️ **출력 SQL 이 `cross join` 이라 `places` 에 그 도시가 없으면 에러 없이 0행이 들어간다.**
조용히 비는 걸 막으려면 반드시 돌려라.

```sql
select p.slug, p.canonical_name, count(a.id) as n
  from places p
  left join attractions a on a.city_id = p.id
 where p.kind = 'city'
 group by 1, 2
having count(a.id) = 0
 order by p.id;
```

### 5. 사진을 채운다

프롬프트가 `image_url` 을 안 쓰게 막아둔 건, 모델에게 이미지 주소를 물으면
**그럴듯한 CDN 주소를 지어내기** 때문이다. 게다가
[checkedImage](../../src/modules/attraction/attraction-admin.controller.ts) 는 `https` 인지만
보고 **실제로 열리는지는 확인하지 않아서**, 지어낸 주소가 그대로 저장되고 카드의
깨진 자리로만 드러난다. 그 카드는 단톡방에 영구히 남는다.

사진은 목록이 들어간 뒤 위키미디어에서 찾는다. 도시 단위 엔드포인트라 전부 돌리려면:

```bash
BASE=https://bot.nolmoa.com DEBUG_TOKEN=xxx ./fill-images.sh
```

`X-Debug-Token` 은 **운영자 확인용 비밀번호일 뿐 유료 API 키가 아니다.**
이 단계는 모델을 안 부른다 — 위키미디어 API 는 키가 없고 무료다
([attraction-image.ts](../../src/modules/attraction/attraction-image.ts)).
돈이 나가는 건 3단계(다른 AI 에게 `prompt.txt` 를 돌리는 것)뿐이다.

한 도시만 다시 채우려면:

```bash
curl -X POST https://bot.nolmoa.com/api/v1/admin/attractions/images \
     -H "X-Debug-Token: $DEBUG_TOKEN" -H 'Content-Type: application/json' \
     -d '{"city":"오사카"}'
```

적중률이 `name_en` 에 달려 있다. [0011 마이그레이션](../../supabase/migrations/0011_attraction_image_source.sql)
의 후쿠오카 실측 — **영문명 없으면 14곳 중 4곳, 있으면 11곳.** 그래서 프롬프트 6번 규칙이
이 작업에서 제일 값이 비싸다.

---

## 들어간 행을 나중에 어떻게 보나

전부 `source='ai'` 로 들어간다. `'manual'` 로 쓰지 말라고 한 이유가 이것이다 —
[0010](../../supabase/migrations/0010_attraction_backfill.sql) 이 그 컬럼을 둔 목적이
"무엇을 의심해야 하는지" 를 남기는 것이라, 거짓으로 적으면 검수 단서가 사라진다.

```sql
-- 모델이 넣은 것 중 사진이 안 붙은 줄 (검수 1순위)
select p.canonical_name, a.name, a.name_en
  from attractions a join places p on p.id = a.city_id
 where a.source = 'ai' and a.image_url is null
 order by p.id, a.rank;
```

되돌리려면 도시 단위로 지우면 된다. 카운터([0012](../../supabase/migrations/0012_attraction_counters.sql))가
같이 날아가지만, 아직 노출된 적 없는 행이면 잃을 게 없다.

```sql
delete from attractions
 where source = 'ai'
   and city_id = (select id from places where slug = 'osaka' and kind = 'city');
```

---

## 6. 사진을 못 찾은 줄의 영문명을 채운다

5단계를 끝내고 집계했더니 `name_en` 유무가 사진 적중률을 거의 전부 설명했다:

|  | `name_en` 있음 | `name_en` 없음 |
|---|---|---|
| **사진 있음** | 778 | 130 |
| **사진 없음** | 31 | **351** |

영문명이 있으면 **96%**(778/809)가 사진을 찾았고, 없으면 **27%**(130/481)였다.
[0011](../../supabase/migrations/0011_attraction_image_source.sql) 의 후쿠오카
실측(4/14 → 11/14)이 1,290건 규모에서 그대로 재현된 셈이다.

이유는 [attraction-image.ts](../../src/modules/attraction/attraction-image.ts) 에
있다 — `ko → en → commons` 중 `en` 은 영문명이 없으면 **통째로 건너뛰고**,
커먼즈 파일명은 거의 영문이라 한국어로는 거의 안 걸린다.

**그래서 남은 실패 382건 중 351건이 영문명 하나로 막혀 있다.** 나머지 31건은
영문명이 있는데도 못 찾은 것이라 손댈 게 없다 (위키미디어에 사진이 없는 장소다).

### 절차

1. `prompt-name-en.txt` 를 통째로 다른 AI 에 붙인다. 끊기면 `계속`
2. 받은 UPDATE 문을 Supabase SQL Editor 에서 실행
3. `fill-images.sh` 를 **한 번 더** 돌린다 — 사진이 빈 칸만 다시 간다

⚠️ **목록을 새로 만들라는 게 아니다.** 기존 행의 `name_en` 칸만 채운다. 그래서
프롬프트가 id 로 UPDATE 하게 돼 있고, "모르면 그 줄을 통째로 빼라" 고 못 박았다 —
틀린 영문명은 비어 있는 것보다 나쁘다. **엉뚱한 장소의 사진**을 물고 오기 때문이다.

### 대상 목록을 다시 뽑으려면

```sql
select a.id, p.canonical_name, a.name, a.area
  from attractions a join places p on p.id = a.city_id
 where a.image_url is null and a.name_en is null
 order by a.id;
```

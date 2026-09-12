# 라우터 — 진입점이 하나인 구조

> 오픈빌더에서 시나리오 블록·엔티티·대표 명령어를 **전부 지웠다.** 봇을 멘션한 모든 발화가
> 폴백으로 떨어지고, 폴백 블록이 부르는 엔드포인트는 하나뿐이다.
>
> ```
> POST https://bot.nolmoa.com/api/v1/kakao/router
> Header: X-Skill-Token: <KAKAO_SKILL_TOKEN>
> ```

이 문서는 그 하나의 경로가 무엇을 하는지 적는다. 도메인별 상세는
[FLIGHT.md](FLIGHT.md) · [ATTRACTION.md](ATTRACTION.md), DB 는 [DB.md](DB.md).

---

## 1. 한눈에

```
[단톡방] "@여행메이트 오사카 호텔 4명 9월 22~24일 추천해줘"
    ↓
POST /api/v1/kakao/router
    ↓
① 더보기인가?  action.clientExtra.cache_key 가 있으면
      → 저장된 행에서 offset 만큼 잘라 즉시 반환. **AI 호출 0회** [끝]
    ↓
② 여행 신호가 있나?  (정규식 TRAVEL_HINT)
      → 없으면 도움말 카드. **AI 호출 0회** [끝]
      ⚠️ 봇 멘션("@여행메이트")은 먼저 떼어낸다. 봇 이름에 "여행" 이 들어 있어서
         안 떼면 인사말까지 이 필터를 통과한다.
    ↓
③ 의도 + 지역 추출   키워드+사전으로 되면 0원, 아니면 모델 1회
      → { intent, place, from, trip_type, ignored }
      → intent 가 unknown 이면 도움말, place 가 없으면 되묻기 [끝]
    ↓
④ 지역 정규화 → place_id   (사전 → place_aliases → 모델 → 원문 등록)
    ↓
⑤ 캐시 키 생성 → search_results 조회
      HIT  → 1페이지(5건) 즉시 반환 [끝]
      MISS → pending 선점 → 대기 응답 → [백그라운드] AI 검색 → 저장 → 콜백 푸시
```

**요청 경로에서 도는 건 ⑤의 조회까지다.** 카카오는 5초 안에 응답을 받아야 하고
AI 검색은 7~30초다. 이 선을 넘는 코드가 하나라도 생기면 그 도메인은 통째로 무응답이 된다.

---

## 2. 왜 진입점이 하나인가

블록이 없으면 카카오는 "이 발화가 호텔인지 항공권인지" 를 안 알려준다. 그래서 **무엇을
묻는지부터 서버가 정한다.** 대신 얻는 게 크다.

- 단톡방에서 `/호텔검색` 같은 명령어를 외우지 않아도 된다. 그냥 말하면 된다
- 엔티티 목록(237개 도시)을 오픈빌더와 코드 양쪽에서 맞춰둘 필요가 없다
- 세부 지역("도톤보리")이 저절로 처리된다 — 엔티티에 없는 값이라고 버려지지 않는다

잃는 것도 분명하다. **발화 해석이 틀리면 아무것도 안 된다.** 그래서 해석은 3단이다
(캐시 → 키워드+사전 → 모델), 모델이 뻗어도 키워드로 의도는 살린다.

---

## 3. 5초 예산

| 상황 | 응답 |
|---|---|
| 저장된 결과 있음 | `listCard` 5건 + 고지 말풍선 + 더보기 버튼 |
| 더보기 | 저장된 행에서 잘라 즉시. AI 0회 |
| 미스 + 콜백 켜짐 | `useCallback` → 잠시 뒤 `callbackUrl` 로 카드 POST |
| 미스 + 콜백 꺼짐 | "찾고 있어요. 30초쯤 뒤에 다시 물어봐 주세요" |
| 다른 사람이 조회 중 | "먼저 찾고 있어요. 잠시 뒤 다시 물어봐 주세요" |
| 여행 무관 / 의도 불명 | 도움말 카드 |
| 지역을 못 뽑음 | "어느 지역 호텔을 찾으세요?" + 예시 퀵리플라이 |
| 검색 실패·빈손 | "지금은 정리하지 못했어요. 잠시 뒤 다시 물어봐 주세요" |

> ⚠️ **그룹챗봇이 콜백 푸시를 실제로 받는지 검증되지 않았다.** 팀톡방에서 확인하고,
> 안 되면 폴백 블록의 [콜백 사용] 을 꺼라 — 코드는 `callbackUrl` 이 없으면 자동으로
> "다시 물어봐 주세요" 경로로 간다.

---

## 4. 캐시 — 지역으로만 가른다

| 종류 | 키 | TTL |
|---|---|---|
| 관광지 | `attraction:{place_id}` | 30일 |
| 호텔 | `hotel:{place_id}` | 24시간 |
| 항공권 | `flight:{from_place_id}>{to_place_id}:{rt\|ow}` | 6시간 |

**날짜·인원은 키에 넣지 않는다.** 넣으면 캐시가 거의 안 맞아 질문 하나가 곧 AI 호출
하나가 된다. 대신 **반영하지 않았다는 사실을 카드 아래에 반드시 적는다.**

```
AI가 정리한 참고 정보예요. 가격은 실제와 다를 수 있어요.
날짜·인원(4명, 9월 22일~24일)은 반영되지 않았어요.
```

> ⚠️ 이 고지가 설계의 전제 조건이다. "9월 22~24일 4명" 을 말한 사람에게 지역 기준
> 결과를 주면 그 날짜에 예약 불가한 호텔과 다른 가격이 섞인다. 고지 없이는 사용자가
> 속았다고 느낀다.

항공권은 **출발지·도착지·왕복여부** 셋이 다 키에 들어간다. 지역만으로 잡으면 왕복을
물은 사람에게 편도 결과가 나간다.

### 동시 호출 방지 (single-flight)

캐시가 빈 상태에서 세 명이 동시에 "오사카 호텔" 을 치면 AI 가 세 번 돈다. 행을
`pending` 으로 **먼저 꽂은 쪽만** 검색한다 — Redis 없이 Postgres 만으로 된다.

```sql
insert into search_results (cache_key, kind, place_id, status)
values ($1, $2, $3, 'pending')
on conflict (cache_key) do nothing
returning cache_key;      -- 돌려받으면 내가 선점한 것
```

- 선점 성공 → AI 호출 → `status = 'ready'` + 20건 저장
- 선점 실패 → "먼저 찾고 있어요"
- 실패·빈손 → `status = 'failed'` + 짧은 TTL (재시도 허용)
- 프로세스가 죽어 pending 이 남으면 `PENDING_TIMEOUT_SECONDS` 뒤 다음 사람이 되찾아간다

**빈 결과는 한 번으로 굳히지 않는다.** 모델은 같은 질의에도 가끔 빈손으로 돌아온다.
한 번에 10분을 굳히면 그게 10분짜리 장애가 된다("도쿄 호텔" 이 실제로 그랬다) —
연속 두 번일 때만 `FAILED_TTL_MINUTES` 를 건다.

### 만료된 행은 지우지 않는다

만료됐는데 항목이 남아 있으면 **그걸 먼저 보여주고** 백그라운드에서 새로 찾는다.
"예전에 찾아둔 정보예요" 한 줄이 붙는다. 아무것도 못 주는 것보다 낫다.

---

## 5. 지역 정규화 — 캐시 적중률이 여기서 결정된다

"오사카" / "osaka" / "오사카시" 가 같은 `place_id` 로 모이지 않으면 같은 지역을 물어도
AI 가 매번 돈다. 찾는 순서는 넷이고, 위에서 걸리면 아래는 안 본다.

1. **프로세스 메모리** — 0ms·0원
2. **`place_aliases`** — 전에 누군가 물어봐서 등록된 지역
3. **도시 사전**([city-table.ts](../src/modules/places/city-table.ts), 237개) — 0ms·0원, 공항 코드가 딸려 온다
4. **모델** — 사전에 없는 곳(도톤보리·해운대·시부야). 표준명·국가·종류를 물어 등록한다

**목록을 미리 채우지 않는다. 쓰면서 자란다.**

세부 지역은 **자기 place 를 갖고** `parent_id` 로 도시에 매달린다. 오사카의 별칭으로
합치면 "도톤보리 주변" 이라는 정보가 사라지기 때문이다. 검색 질의에는 부모를 붙여
넘긴다("도톤보리 오사카") — 세부 지역만 주면 모델이 어디인지 모른다.

> ⚠️ **지역을 검증하지 않는다.** 모델까지 실패해도 원문으로 place 를 만들어 검색에
> 넘긴다. "그런 도시 없어요" 로 막지 않는 게 규칙이고, 틀렸다면 결과가 비는 것으로
> 드러난다.

---

## 6. 더 보기 — 버튼이 커서를 들고 다닌다

한 번의 검색으로 **20건을 한 행에 통째로 저장**하고 listCard 5줄에 맞춰 **5건씩 4페이지**로
낸다. 2페이지를 위해 AI 를 다시 부르지 않는다.

```json
{
  "label": "더 보기",
  "action": "block",
  "blockId": "<폴백 블록 ID>",
  "messageText": "오사카 호텔 더 보기",
  "extra": { "cache_key": "hotel:12", "offset": 5 }
}
```

서버는 "누가 어디까지 봤는지" 를 기억하지 않는다. **마지막 페이지에는 버튼을 달지
않는다** — 눌러도 같은 5개가 나오면 사용자는 그걸 고장으로 읽는다.

`blockId` 는 설정(`KAKAO_BLOCK_ID_FALLBACK`)이 비어 있으면 **요청이 알려준
`userRequest.block.id`** 를 쓴다. 라우터로 들어온 요청은 곧 폴백 블록이 부른 요청이므로
그게 정답이고, 블록을 다시 만들어 ID 가 바뀌어도 저절로 따라간다.

> ⚠️ **그룹챗방에서 `action: "block"` 이 되는지 검증되지 않았다** (itemCard 가 안 됐던
> 전례가 있다). 버튼을 눌렀는데 반응이 없으면 `MORE_BUTTON_STYLE=message` 로 내려라 —
> 그 경로는 커서를 못 실으므로 서버가 **발화자별로** 다음 페이지를 30분간 기억한다.

---

## 7. 카드는 전부 `listCard`

항공권도 `carousel` + `itemCard` 가 아니라 단일 `listCard` 다.

> ⚠️ **그룹챗봇은 itemCard 를 못 그린다 — 말풍선이 통째로 사라진다.** 팀톡방에서
> 항공권만 무응답이던 원인이 이것이다. 정보 밀도를 잃더라도 보이는 카드가 낫고,
> 상세는 줄 링크(`/r/{clickId}`)로 넘긴다.

`listCard.buttons` 는 최대 2개, 줄은 5개, 제목 40자·설명 40자다. 넘기면 잘리는 게
아니라 **말풍선이 통째로 안 보인다** — [templates.ts](../src/modules/kakao/templates.ts)
가 빌더 단계에서 잘라 넣는 이유다.

고지는 카드 **뒤에** 오는 별도 말풍선이다. header 40자에는 안 들어가고, 앞에 세우면
결과를 가린다.

---

## 8. 파일 지도

| 파일 | 하는 일 |
|---|---|
| [router.controller.ts](../src/modules/kakao/router.controller.ts) | 유일한 진입점. 위 ①~⑤ 분기 |
| [intent.service.ts](../src/modules/intent/intent.service.ts) | 의도·지역·무시한 조건 추출 (캐시 → 키워드 → 모델) |
| [places.service.ts](../src/modules/places/places.service.ts) | 지역 정규화·자동 등록 |
| [search.service.ts](../src/modules/search/search.service.ts) | 캐시 조회·선점·백그라운드 검색·페이지·콜백 |
| [search-store.service.ts](../src/modules/search/search-store.service.ts) | 저장소 2단(메모리 → Supabase) + 선점 |
| [paging.ts](../src/modules/kakao/paging.ts) | 커서·페이지 자르기·더보기 버튼 |
| [cards.ts](../src/modules/kakao/cards.ts) | 사용자가 읽는 문구 (도움말·고지·실패) |
| [templates.ts](../src/modules/kakao/templates.ts) | 카카오 응답 JSON 빌더 |
| hotel/ · flight/ · attraction/ | 도메인 — "어떻게 찾고 어떻게 한 줄로 그리는가" 만 |

도메인은 서로를 모르고, 라우터는 도메인을 모른다. 네 번째 도메인이 생겨도
`search.service.ts` 는 그대로다 ([SearchDomain](../src/modules/search/search.types.ts)).

---

## 9. 확인하는 방법

```bash
# 해석만 (싸다) — 왜 도움말이 나오는지 가릴 때
curl -s -X POST localhost:8000/api/v1/debug/parse \
  -H 'content-type: application/json' -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"utterance":"오사카 호텔 4명 9월 22~24일 추천해줘"}' | jq

# 전체 파이프라인 (동기, 7~30초, OpenAI 요금)
curl -s -X POST localhost:8000/api/v1/debug/search \
  -H 'content-type: application/json' -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"utterance":"도톤보리 맛집 알려줘"}' | jq .response
```

라우터 응답만 봐서는 **검색 성공·실패를 알 수 없다** (늘 "찾고 있어요" 다).
`/api/v1/debug/search` 는 끝까지 기다렸다가 **사용자에게 실제로 배달될 말풍선**을
그대로 돌려준다 — 조립은 운영과 같은 코드를 태우고, 통계만 남기지 않는다.

`DEBUG_TOKEN` 이 비어 있으면 이 경로는 **404** 다.

---

## 10. 아직 검증되지 않은 것

팀톡방에서 확인해야 한다. 셋 다 안 되는 쪽으로 폴백이 준비돼 있다.

- [ ] **콜백 푸시가 도착하는가** → 안 되면 폴백 블록의 [콜백 사용] 을 끈다
- [ ] **`action: "block"` 버튼이 동작하는가** → 안 되면 `MORE_BUTTON_STYLE=message`
- [ ] **AI 가 20건을 안정적으로 주는가** → 품질이 떨어지면 `RESULT_MAX_ITEMS` 를 10~15로

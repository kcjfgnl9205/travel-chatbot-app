# 항공권 검색 — 어떻게 도는가

카카오 발화 한 줄이 `itemCard` 캐러셀이 되기까지의 전 과정.

정의 원본은 코드다. 이 문서는 **왜 그렇게 생겼는지**와 **손댈 때 뭘 깨뜨릴 수 있는지**를 설명한다.

> **전제**: 실시간 운임 API 가 없다. gpt-5-mini 가 웹을 검색해 "그 노선이 대략 얼마인가"를 찾아오고, 애드픽 API 가 예약 링크를 커미션 링크로 바꾼다. 사용자에게는 우리 리다이렉트만 노출된다.

호텔 쪽 흐름은 [README](../README.md#호텔은-어떻게-찾는가), DB 는 [DB.md](DB.md).

---

## 1. 한눈에

```
"다음달 3일 오사카 왕복 항공권 2명"
   │
   ├─ ① 발화 파싱  FlightNluService   gpt-5-nano  (~2-4초, 5초 예산 안)
   │     → { ICN→KIX, 2026-10-03, round, 2명 }
   │
   ├─ ② 사용자/메시지 로깅            users · messages (domain='flight')
   │
   ├─ ③ 캐시 조회  SearchCacheService  메모리 → Supabase   (수십 ms)
   │     ├─ 히트 → ⑤ 로 바로 간다
   │     └─ 미스 → 여기서 응답을 만들 수 없다 (검색이 7~30초)
   │              ↓
   │        useCallback 응답 반환 ────────────────┐  카카오에 5초 안에
   │              ↓ (백그라운드)                  │  "곧 보낼게" 만 알린다
   ├─ ④ 검색  OpenAiFlightProvider                │
   │     1차: web_search 로 후보 15편 수집         │
   │     2차: 가격·경유·시각 비교 후 5편 선정       │
   │     → 정규화 (호스트 검증 / 시각 HH:MM / 한국어 URL)
   │     → search_cache 저장 (30분)               │
   │              ↓                               │
   ├─ ⑤ 애드픽 변환  AffiliateService (캐시 우선)  │
   │     예약 주소 → 커미션 링크                    │
   │              ↓                               │
   ├─ ⑥ 카드 조립  simpleText + itemCard 캐러셀     │
   │     편마다 clickId 발급 → recommendation_items │
   │              ↓                               │
   └─ ⑦ callbackUrl 로 POST ──────────────────────┘  (카카오 1분 예산)

[카드 버튼 클릭] → /r/{clickId} → click_count +1 → 302 → 커미션 링크 → trip.com
```

**⚠️ ④를 요청 경로에서 부르면 안 된다.** 카카오는 5초 안에 응답을 받아야 하는데 검색은 7~30초다. 요청 경로에서 도는 건 ①②③뿐이다.

진입점: [`flight.service.ts`](../src/modules/flight/flight.service.ts) `handle()`

---

## 2. 발화 파싱 — 호텔 파서와 왜 갈랐나

[`flight-nlu.service.ts`](../src/modules/nlu/flight-nlu.service.ts)

항공권은 뽑아야 하는 게 다르다.

| | 호텔 | 항공권 |
|---|---|---|
| 장소 | 도시 **1개** | 출발지 + 도착지 **2개** |
| 날짜 | 있으면 좋은 정보 | **결과를 완전히 바꾼다** (10/3 과 10/4 는 다른 검색이다) |
| 축 | 인원, 박수 | 인원, 좌석등급, **편도/왕복** |

한 스키마에 다 넣으면 호텔 파싱이 항공권 필드를 매번 `null` 로 채운다. 그건 5초 예산 안에서 도는 호출에 붙는 순수한 낭비다. 그래서 파서를 둘로 두고, 캐시·타임아웃 규칙만 같게 맞췄다.

### 스키마 (구조화 출력, strict)

```
origin_name / origin_slug / origin_code          출발 (없으면 null)
destination_name / destination_slug / destination_code
depart_date / return_date                        YYYY-MM-DD
trip_type                                        oneway | round
passengers / cabin
```

### ⚠️ 상대 날짜는 모델이 절대 날짜로 바꾼다

"다음달 3일", "이번 주말", "내일" 을 그대로 두면 검색 프롬프트가 망가진다. 그래서 **입력에 오늘 날짜를 실어 보낸다.**

```ts
input: `오늘은 ${todayInSeoul()} 이다.\n발화: ${utterance}`
```

`todayInSeoul()` 은 `Asia/Seoul` 기준이다. 서버가 UTC 로 떠 있으면 한국 시각 오전 9시 전까지는 어제가 되고, 그 상태로 "내일" 을 시키면 사용자에게는 **오늘 표**가 검색된다.

모델이 뭘 주든 `isoDate()` 가 `YYYY-MM-DD` 만 통과시킨다. 형식만 보는 게 아니라 **실재하는 날짜인지도 본다** — `Date` 는 `2026-02-30` 을 3월 2일로 굴려버리므로, 파싱한 뒤 되돌려 같은 문자열인지 확인한다.

### ⚠️ 별칭 캐시 키에 오늘 날짜가 섞인다

```ts
private keyOf(utterance) { return `${todayInSeoul()}:${utteranceKeyOf(utterance)}` }
```

호텔은 발화만으로 키를 만든다("오사카 호텔" 의 답은 어제도 오늘도 같다). 항공권은 아니다 — **어제 파싱한 "내일" 은 오늘의 내일이 아니다.** 이 한 줄을 지우면 날짜가 하루씩 밀린 검색이 캐시에서 나간다.

### 오픈빌더 엔티티

엔티티가 오면 모델을 부르지 않는다 (더 빠르고 공짜). 보는 이름:

| 필드 | 파라미터 이름 |
|---|---|
| 출발지 | `origin` · `departure` · `from_city` |
| 도착지 | `destination` · `arrival` · `to_city` · `city` · `sys_location` |
| 가는 날 | `depart_date` · `date` · `sys_date` |
| 오는 날 | `return_date` |

**⚠️ 날짜 엔티티가 와도 모델을 부른다.** `sys_date` 가 "다음달 3일" 을 절대 날짜로 주지 않을 때가 있고, 그러면 검색이 통째로 틀어진다. `YYYY-MM-DD` 형식만 엔티티 값으로 받아들이고, 아니면 버리고 모델에 맡긴다.

### 실패하면 되묻는다

5초 예산이 걸린 자리다. 타임아웃(`OPENAI_PARSE_TIMEOUT_SECONDS`, 기본 4초)·JSON 파싱 실패·키 없음은 전부 "목적지 미상"으로 떨어지고 되묻기 말풍선이 나간다. 예산을 넘겨 카카오에 아무것도 못 주는 것보다 낫다.

> 실측 3.5초. 항공권은 필드가 많아 호텔 파싱보다 느리다. 되묻기가 잦으면 이 값을 올린다 — `/api/v1/debug/flight-search?trace=true` 의 `parse.timedOut` 이 "못 알아들었다"와 "물어보지도 못했다"를 구분해준다.

### 출발지는 파서가 추측하지 않는다

"오사카 항공권" 처럼 출발지를 빼고 말하는 게 보통이다. 파서는 `null` 을 주고, 채우는 건 [`FlightService.queryOf()`](../src/modules/flight/flight.service.ts) 다.

```
originSlug 없음 → FLIGHT_DEFAULT_ORIGIN_NAME/CODE (서울/ICN) + originAssumed: true
```

`originAssumed` 플래그가 카드까지 따라가서 안내 말풍선에 **"서울 출발 기준이에요"** 를 찍는다. 부산에서 출발하려던 사람이 그 한 줄을 보고 고쳐 말할 수 있어야 한다 — 조용히 추측하면 잘못된 노선의 가격을 믿게 된다.

파싱과 기본값 채우기를 나눈 이유: 파서가 서울을 채워버리면 "사용자가 서울이라고 말했다"와 "우리가 서울이라고 가정했다"를 구분할 수 없다.

---

## 3. 검색 — gpt-5-mini 2단 호출

[`providers/openai.provider.ts`](../src/modules/flight/providers/openai.provider.ts)

호텔과 같은 2단 구조다. 이유도 같다 — 한 번에 시키면 모델이 검색 결과를 **요약**하는 데 힘을 쓰고 비교·선별은 대충 한다. 갈라두면 단계별로 계측·디버깅도 된다.

| | 1차 (findCandidates) | 2차 (rank) |
|---|---|---|
| 목적 | 후보 15편 수집 (`OPENAI_CANDIDATE_COUNT`) | 상위 5편 선정 (`FLIGHT_RESULT_LIMIT`) |
| 툴 | `web_search` | 없음 (후보 JSON 만 본다) |
| effort | `OPENAI_SEARCH_EFFORT` (low) | `OPENAI_RANK_EFFORT` (low) |
| 스키마 | `flight_candidates` | `flight_picks` |

### ⚠️ 두 호출 다 구조화 출력을 건다

1차를 자유 텍스트로 두면 모델이 **"이렇게 정리해 드리겠습니다. 진행할까요?"** 라고 되묻고 끝난다. 호텔 쪽에서 실제로 그래서 후보가 0개가 된 적 있다. 상대는 사람이 아니라 프로그램이라 그 질문에 답해줄 사람이 없다.

프롬프트에도 같은 방어가 있다. **`'**절대 되묻지 마라.**'` 문단을 지우지 마라.**

### ⚠️ 날짜가 없으면 "지어내지 말고 일반적인 요금대를 조사하라"고 시킨다

`conditionsText()` 가 만드는 문장이다. 이 지시가 없으면 모델이 임의의 날짜를 정해서 검색하거나 날짜를 되묻는다. 둘 다 사용자에게는 잘못된 결과다.

### 허용 호스트 — 호텔은 4곳, 항공권은 2곳

```ts
export const FLIGHT_ALLOWED_HOSTS = ['trip.com', 'myrealtrip.com'];
```

| 호스트 | 호텔 | 항공권 | 이유 |
|---|---|---|---|
| trip.com | ✅ | ✅ | 항공권을 판다 |
| myrealtrip.com | ✅ | ✅ | 항공권을 판다 |
| klook.com | ✅ | ❌ | 항공권을 안 판다 |
| hotels.com | ✅ | ❌ | 항공권을 안 판다 |

안 파는 곳을 허용해두면 모델이 "항공권 링크"라며 엉뚱한 페이지를 가져온다. 반대로 남긴 두 곳은 호텔 쪽에서 이미 애드픽 변환이 되는 게 확인된 곳이라 **수익화 경로가 검증돼 있다.**

**⚠️ 이 목록을 바꾸면 프롬프트 문구(`FLIGHT_ALLOWED_SITES_TEXT`)도 같이 바꿔야 한다.** 모델에게 A 를 찾으라고 시켜놓고 B 만 통과시키면 결과가 전부 버려진다.

### 정규화 — 모델 출력을 못 믿는 자리들

| 대상 | 처리 | 왜 |
|---|---|---|
| `source_url` | 호스트 검증 → 실패면 **버린다** | 모델은 없는 URL 을 그럴듯하게 만든다. 애드픽을 타고 나가면 404 다 |
| `source_url` | `toKoreanUrl()` 로 한국어 페이지로 | 프롬프트가 안 먹었을 때의 마지막 방어선 |
| `depart_time` | `hhmm()` — `HH:MM` 만 통과 | 모델이 `09:20 (현지)`, `오후 2시 30분`, `2:30 PM` 을 섞어 준다. 20자 줄이 터지고 편끼리 비교도 안 된다 |
| `flight_no` | `KE723` 으로 표기 통일 | **dedupe 키다.** `ke 723` 과 `KE723` 이 갈리면 같은 편이 두 장 나간다 |
| `origin_code` / `destination_code` | 없으면 쿼리 값으로 채움 | 검색 자체가 그 노선으로 나갔으므로 쿼리가 더 믿을 만하다 |
| `stops` | `0` 을 유효값으로 취급 | `positiveInt` 로 걸면 **직항이 전부 "모름"이 된다** |
| 시각을 못 읽으면 | `null` (그 줄이 카드에서 빠진다) | 시각 없는 카드가 틀린 시각보다 낫다 |

URL 헬퍼는 호텔과 공유한다 → [`common/booking-url.ts`](../src/common/booking-url.ts). 같은 제휴몰을 쓰므로 "이 호스트를 믿을 수 있나 / 한국어로 어떻게 돌리나"가 도메인마다 다를 이유가 없다. 각자 갖고 있으면 한쪽만 고쳐지고, 그러면 같은 사이트에서 호텔은 한국어인데 항공권은 영어로 나간다.

---

## 4. 캐시와 안전장치

같은 노선을 100명이 물어도 OpenAI 호출은 1회여야 한다. 장치가 세 개다.

| 장치 | 무엇을 막나 | 어디 |
|---|---|---|
| `search_cache` (메모리 → DB) | 같은 조건 재검색 | [`search-cache.service.ts`](../src/modules/search-cache/search-cache.service.ts) |
| `inFlight` Map | **동시** 요청이 각자 검색하는 것 | `FlightService.searchOnce()` |
| `recentlyEmpty` Map (10분) | 없는 노선 연타 | `FlightService.wasRecentlyEmpty()` |

### 캐시 키 축

```ts
flightCacheKey(query) = [출발, 도착, 가는날, 오는날, 편도/왕복, 인원, 좌석, limit]
→ "flight:openai:ICN:KIX:2026-10-03:2026-10-06:round:2::5"
```

**⚠️ 날짜가 반드시 들어가야 한다.** 빠지면 10월 3일을 물은 사람에게 9월 1일 검색 결과가 나간다. 인원·좌석등급도 운임이 달라지므로 같이 넣는다.

`provider` 이름이 키에 있는 이유: `openai` → 실시간 API 로 바꿨을 때 옛 결과가 나오면 안 된다.

### TTL 은 호텔보다 짧다

| | TTL |
|---|---|
| 호텔 | `SEARCH_CACHE_TTL_MINUTES` = 60분 |
| **항공권** | **`FLIGHT_CACHE_TTL_MINUTES` = 30분** |

운임은 하루에도 몇 번 바뀐다. 한 시간 묵은 값은 이미 틀렸을 가능성이 높다. 그래도 캐시를 아예 끄지는 않는다 — 그러면 같은 노선을 물을 때마다 웹 검색 요금이 그대로 나간다.

### 빈 결과는 캐시에 넣지 않는다

일시적 실패를 30분씩 굳히면 안 되니까. 대신 `recentlyEmpty` 에 10분만 기억한다 — 그게 없으면 "asdf 항공권" 연타가 그대로 OpenAI 요금이 된다.

### SearchCacheService 는 도메인을 모른다

호텔이 오는지 항공권이 오는지 알 필요가 없다. 호출부가 **키 축**과 **"이게 우리가 저장한 그 모양인가" 판정**(`isFlight` / `isHotel`)을 준다. 도메인이 늘 때마다 캐시 파일을 고쳐야 한다면 그건 캐시가 아니라 호텔 코드다.

`isFlight` 가 필요한 이유: 배포로 필드 모양이 바뀌면 옛 payload 가 깨진 카드를 만든다. 모양이 안 맞으면 **미스로 떨어뜨린다.**

---

## 5. 카드 — `itemCard` 캐러셀

[`templates.ts`](../src/modules/kakao/templates.ts) · 문구는 [`flight.types.ts`](../src/modules/flight/flight.types.ts)

### 왜 listCard 가 아닌가

listCard 한 줄은 **40자**다. 항공권 1건을 고르려면 항공사·편명·출발/도착 시각·소요·경유·가격이 다 필요하다. 안 들어간다.

`itemCard` 는 key-value 줄을 세로로 쌓을 수 있어서 그게 들어간다. 캐러셀로 넘기면 편끼리 비교도 된다.

### 실제 모양

```
simpleText  서울→오사카 왕복 항공권 5편이에요 ✈️
            가는 날 10/3(토) · 오는 날 10/6(화) · 2명
            서울 출발 기준이에요. 다른 곳이면 "부산에서 출발" 처럼 알려주세요.
            가격은 검색 시점 기준이라 실제 예약가와 다를 수 있어요.

carousel    head      서울 → 오사카 · 10/3(토)
 (itemCard) itemList  항공사 │ 대한항공 KE723
                      가는편 │ 10/3(토) 09:20→11:00
                      오는편 │ 10/6(화) 12:30→14:20
                      소요   │ 1시간 40분 · 직항
            summary   예상가 │ 1인 289,000원
            button    예약 페이지 보기 → /r/{clickId}
```

JSON 예시는 [README](../README.md#항공권은-itemcard-캐러셀) 와 Swagger(`/docs`) 응답 예시에 있다.

### 앞에 말풍선을 하나 세우는 이유

캐러셀에는 listCard 의 `header` 같은 자리가 없다. 노선·조건·가격 주의 같은 **공통 맥락**을 카드마다 반복해 넣을 수는 없으니 앞에 `simpleText` 로 세운다 (카카오는 `outputs` 를 3개까지 받는다). → `t.textThenCarousel()`

그런데 `head.title` 에도 노선을 또 적는다. 낭비처럼 보이지만 **캐러셀은 카드를 하나씩 넘겨 보기 때문에**, 앞 말풍선을 지나친 사용자에게는 그게 유일한 맥락이다.

### ⚠️ 제한을 넘기면 잘려 보이는 게 아니라 말풍선이 통째로 안 뜬다

| 자리 | 제한 | 상수 |
|---|---|---|
| `head.title` | 30자 (2줄) | `MAX_ITEM_CARD_HEAD` |
| `itemList` | **5줄** | `MAX_ITEM_LIST_ROWS` |
| `itemList[].title` | **6자** | `MAX_ITEM_LIST_TITLE` |
| `itemList[].description` | 20자 (1줄) | `MAX_ITEM_LIST_DESC` |
| `itemListSummary` | title 6자 / desc 20자 | 위와 같음 |
| `buttons` | 3개 | `MAX_ITEM_CARD_BUTTONS` |
| 캐러셀 카드 | **10장** | `MAX_CAROUSEL_ITEMS` |
| 퀵리플라이 | 10개 / 라벨 14자 | `MAX_QUICK_REPLIES` |

전부 `templates.ts` 가 잘라 넣는다. 지켜야 할 규칙 둘:

1. **값이 빈 줄은 만들지 않는다.** `description` 이 빈 항목이 있으면 카카오가 카드를 렌더링하지 않는다. `cardRows()` 는 시각을 모르면 그 줄을 아예 빼고, 항공사 한 줄만 남을 수도 있다.
2. **5줄은 이미 거의 찼다.** 왕복이면 항공사·가는편·오는편·소요로 4줄이다. 새 줄을 넣기 전에 **무엇을 뺄지 먼저 정해야 한다.** 좌석 등급은 자리가 남을 때만 들어간다 — 있으면 좋은 정보에 "카드가 아예 안 보일" 위험을 걸지 않는다.

`itemListAlignment: "right"` 는 취향이 아니다. 시각과 금액이 세로로 정렬돼야 카드를 넘기며 비교할 수 있다.

### 문구 규칙

| 함수 | 출력 | 규칙 |
|---|---|---|
| `dateLabel('2026-10-03')` | `10/3(토)` | 20자 줄에 맞추려고 연도를 버린다. **UTC 자정으로 파싱**한다 — 지역 시간대로 파싱하면 서버 위치에 따라 요일이 하루 밀린다 |
| `legText(날짜, 출발, 도착)` | `10/3(토) 09:20→11:00` | 19자. 화살표 하나로 붙여야 20자에 들어간다 |
| `durationLine()` | `1시간 40분 · 직항` | 모르는 값은 문장에서 빠진다 |
| `priceText()` | `289,000원` / `가격 문의` | 가격을 모르면 **지어내지 않는다** |
| `priceSummary()` | `1인 289,000원` | 2명 이상이면 1인 기준임을 밝힌다. 총액인지 1인당인지 모르면 예산을 짤 수 없다 |
| `cabinText('business')` | `비즈니스` | 모르는 값은 그대로 둔다 (버리면 정보가 사라진다) |

### 중복 제거 — ⚠️ 주소로 하면 안 된다

```ts
flightKey(f) = [편명 ?? 항공사, 출발공항, 도착공항, 날짜, 출발시각].join('|')
```

호텔은 `sourceUrl` 이 곧 호텔의 신원이라 그걸로 판정한다. **항공권은 여러 편이 같은 노선 검색 페이지를 가리킨다.** 주소로 중복을 지우면 **카드가 한 장만 남는다.**

편명+출발시각이 항공편의 신원이다. 그래서 `flight_no` 표기 통일(`hhmm`/`flightNumber`)이 dedupe 정확도에 직결된다.

---

## 6. 링크와 추적

호텔과 **완전히 같은 경로**를 쓴다. 재사용이 목적이었고 실제로 그렇게 됐다.

```
예약 주소 (kr.trip.com/flights/...)
   ↓ 애드픽 API (affiliate_links 에 캐시, source_url 단위)
커미션 링크 (link.adpick.co.kr/xxxxxxxx)
   ↓ 카드 버튼은 이걸 직접 가리키지 않는다
/r/{clickId} → click_count +1 → 302 → 커미션 링크
```

**변환이 실패해도 카드는 나간다.** 원본 주소로 폴백한다 — 수익화는 못 해도 사용자는 항공권을 본다. 그때 `애드픽 변환 실패 N/M건` 경고가 로그에 남는다. 방치하면 그대로 매출이 샌다.

### 항공권에서 다른 점 하나

애드픽 변환은 `sourceUrl` 단위로 묶인다. 항공권은 여러 편이 같은 주소를 공유하므로 **변환 호출 수가 카드 수보다 적다** (호텔은 5곳이면 5회). `clickId` 는 그래도 편마다 따로 발급되므로 어느 편을 눌렀는지는 구분된다.

### DB — 새 테이블이 없다

`domain` 컬럼(`hotel` | `flight`)이 둘을 가른다. 이유는 [`0002_flight.sql`](../supabase/migrations/0002_flight.sql) 주석에 있다 — 요약하면 집계 질문이 도메인을 가로지르고(`union` 지옥), 클릭 추적 경로가 하나뿐이기 때문이다.

컬럼 이름이 호텔 시절 그대로인 것들:

| 컬럼 | 항공권일 때 담기는 것 |
|---|---|
| `recommendation_items.hotel_name` | 항공편 이름 (`대한항공 KE723 ICN→KIX`) |
| `recommendation_items.price_from` | 1인 총액 (⚠️ 예상가) |
| `recommendation_items.thumbnail_url` | 항상 `null` (카드에 이미지가 없다) |
| `messages.parsed_city` | **목적지** 도시 (출발지는 남기지 않는다) |
| `recommendations.city_slug` | 목적지 도시 |
| `recommendations.guests` | 탑승 인원 |

이름을 안 바꾼 이유: `register_click()` 의 반환 시그니처와 앱의 읽기 코드까지 같이 옮겨야 하고, 그 사이 배포에서 클릭이 유실된다. 이름이 `hotel_name` 인 채로 항공편 이름이 들어가는 게 그 위험보다 낫다. 대신 컬럼 주석이 그 사실을 말해준다.

---

## 7. 호텔과 다른 점만 모아서

같은 걸 두 번 읽지 않도록. **흐름·5초 예산·콜백·in-flight 병합·애드픽·리다이렉트·DB 는 전부 동일하다.**

| | 호텔 | 항공권 |
|---|---|---|
| 엔드포인트 | `/api/v1/kakao/hotels/recommend` | `/api/v1/kakao/flights/search` |
| 파서 | `NluService` (도시+인원) | `FlightNluService` (노선+날짜+편도/왕복) |
| 파서 캐시 키 | 발화 | **오늘 날짜 + 발화** |
| 카드 | `listCard` 한 장 (5줄) | `simpleText` + `itemCard` 캐러셀 |
| 항목 수 | 5 (`HOTEL_RESULT_LIMIT`) | 5 (`FLIGHT_RESULT_LIMIT`), 캐러셀 한계 10 |
| 캐시 TTL | 60분 | **30분** |
| 항목 신원 | `source_url` | **편명 + 출발시각** |
| 허용 호스트 | 4곳 | **2곳** (항공권을 파는 곳만) |
| 이미지 | 예약 페이지에서 긁어온다 | **없다** (신뢰할 만한 이미지원이 없다) |
| 가격 | 1박 최저가 | 1인 총액, **예상가** |
| 기본값 추측 | 없음 | **출발지 = 서울/ICN** (카드에 명시) |

---

## 8. 설정

| 환경변수 | 기본 | 설명 |
|---|---|---|
| `FLIGHT_PROVIDER` | `openai` | 데이터 소스. 갈아끼우면 검색 방식이 바뀐다 |
| `FLIGHT_RESULT_LIMIT` | `5` | 캐러셀은 10장까지 되지만, 5장을 넘기면 고르는 게 아니라 훑는 게 된다 |
| `FLIGHT_CACHE_TTL_MINUTES` | `30` | 운임이 빨리 상한다. 0 으로 끄지 말고 줄이는 쪽을 쓴다 |
| `FLIGHT_DEFAULT_ORIGIN_NAME` | `서울` | 출발지 미상일 때의 기본값 |
| `FLIGHT_DEFAULT_ORIGIN_CODE` | `ICN` | 같음 |

호텔과 공유하는 것: `OPENAI_MODEL`, `OPENAI_SEARCH_EFFORT`, `OPENAI_RANK_EFFORT`, `OPENAI_CANDIDATE_COUNT`, `OPENAI_PARSE_MODEL`, `OPENAI_PARSE_TIMEOUT_SECONDS`, `NLU_ALIAS_TTL_MINUTES`, `SEARCH_CACHE_TTL_MINUTES`(캐시 on/off 판단), `KAKAO_CALLBACK_TIMEOUT_SECONDS`, 애드픽 설정 전부.

> `SEARCH_CACHE_TTL_MINUTES=0` 은 **항공권 캐시까지 끈다.** on/off 판단이 공용이다.

---

## 9. 확인하는 방법

### 카드를 눈으로 보려면

스킬 엔드포인트 응답으로는 **성공·실패를 알 수 없다.** 검색을 기다리지 않으므로 늘 "찾고 있어요" 다. 키가 틀렸든 OpenAI 가 죽었든 응답은 똑같다.

```bash
# 발화에 공백이 있으므로 --data-urlencode 로 넘긴다 (그냥 붙이면 400 이 날 수 있다)
curl -s --get localhost:8000/api/v1/debug/flight-search \
  --data-urlencode 'utterance=다음달 3일 오사카 왕복 항공권 2명' \
  --data 'trace=true' \
  -H "X-Debug-Token: $DEBUG_TOKEN" | jq
```

**조립은 스킬 경로와 같은 코드를 태운다** (`FlightService.previewResponse()`). 진단용으로 카드를 따로 만들면 그건 실제 응답을 검증하는 게 아니다.

- 캐시를 타지 않는다 (매번 실제로 부른다 — 그게 목적이다)
- 통계를 남기지 않는다 (`recommendations` 가 진단 호출로 오염되지 않는다)
- `clickId` 는 인메모리에 남으므로 **버튼을 눌러 이동까지 확인된다**
- 실패해도 200 이고, 카카오에 나갈 안내 문구가 그대로 온다

### `trace=true` 에서 먼저 볼 것

| 필드 | 이게 이상하면 |
|---|---|
| `parsed.departDate` | 상대 날짜가 절대 날짜로 안 바뀜 → 프롬프트/오늘 날짜 주입 확인 |
| `parse.timedOut` | 파싱이 4초를 넘김 → `OPENAI_PARSE_TIMEOUT_SECONDS` 조정 |
| `counts.searchCalls` | **0 이면 모델이 웹 검색 없이 기억으로 답했다** → 그 가격은 믿을 수 없다 |
| `counts.droppedUntrusted` | 크면 모델이 허용 호스트 밖을 가져온다 → 호스트 목록 + 프롬프트 |
| `counts.affiliateFallback` | 0 이 아니면 그만큼 수익화가 안 된다 |
| `flights[].cardRows` | 카카오에 실제로 찍히는 줄. 6자/20자 제한 눈으로 확인 |
| `hint` | 위 상황에 맞는 다음 행동을 문장으로 준다 |

`candidates=true` 를 붙이면 1차 웹 검색 원문이 붙는다 (길다).

### 테스트

```bash
npx jest test/flight-skill.spec.ts    # 스킬 전 구간 (5초 예산·콜백·카드·클릭 추적)
npx jest test/flight-types.spec.ts    # 카드 문구·제한·dedupe 키
npx jest test/flight-nlu.spec.ts      # 발화 파싱·날짜 검증·호스트 검증·시각 정규화
```

실제 OpenAI 를 부르지 않는다. `FLIGHT_PROVIDER` 는 [`fake-flight-provider.ts`](../test/fake-flight-provider.ts), `OpenAiService` 는 [`fake-openai.ts`](../test/fake-openai.ts) 로 갈아끼운다.

---

## 10. 알려진 한계

### ⚠️ 가격이 확정 운임이 아니다

가장 중요한 한계다. 웹 검색으로 얻는 건 "그 노선이 대략 얼마인가"이지 지금 살 수 있는 가격이 아니다. 그래서:

- 카드 요약 줄은 `예상가` 로 적는다 (`최저가` 가 아니다)
- 안내 말풍선에 "가격은 검색 시점 기준이라 실제 예약가와 다를 수 있어요" 가 **항상** 들어간다
- 실제 금액은 예약 페이지에서 확정된다

**이 문구들을 지우지 마라.** 없으면 사용자는 카드 가격을 믿고 눌렀다가 배신당한다.

### 그 외

| 한계 | 지금 상태 |
|---|---|
| 좌석 잔여·실제 예약 가능 여부 | 모른다. 예약 페이지에 위임 |
| 경유 상세(각 구간 시각) | 횟수와 경유지만. itemCard 5줄에 안 들어간다 |
| 다구간(multi-city) | 미지원. 편도/왕복만 |
| 유아·소아 구분 | 미지원. `passengers` 하나뿐 |
| 예약 링크가 특정 편이 아닌 검색 페이지일 수 있음 | 모델이 주는 대로. 노선·날짜는 맞다 |
| 카드 이미지 | 없다 (항공사 로고를 핫링크할 수 없다) |

### 다음 단계

- **실시간 운임 API(GDS·항공사) 연동** — `FlightProvider` 만 구현하면 된다. 서비스·카드 조립·캐시·추적은 그대로다. 그때 `예상가` → `최저가` 로 바꾸고 안내 문구를 걷어낸다
- 유아·소아 인원 분리
- 다구간 지원 (카드 구조를 다시 설계해야 한다 — 5줄에 안 들어간다)

---

## 11. 파일 지도

```
src/
├── common/booking-url.ts                    호스트 검증 / 한국어 URL (호텔과 공용)
├── config/app.config.ts                     FLIGHT_* 환경변수
└── modules/
    ├── kakao/
    │   ├── kakao.controller.ts               POST /flights/search · 폴백
    │   ├── templates.ts                      itemCard · carousel · textThenCarousel
    │   └── dto/skill-request.example.ts      Swagger 예시 (FLIGHT_*)
    ├── flight/
    │   ├── flight.service.ts                 전체 흐름 · 카드 조립 · 안내 문구
    │   ├── flight.types.ts                   Flight · 캐시 키 · 카드 문구 · flightKey
    │   ├── flight.module.ts                  FLIGHT_PROVIDER 주입
    │   ├── flight-debug.controller.ts        GET /api/v1/debug/flight-search
    │   └── providers/openai.provider.ts      2단 호출 · 프롬프트 · 정규화
    ├── nlu/flight-nlu.service.ts             발화 파싱 · 날짜 검증 · 별칭 캐시
    └── search-cache/search-cache.service.ts  도메인 무관 캐시 (호텔과 공용)

supabase/migrations/0002_flight.sql           컬럼 의미 주석 (새 테이블 없음)

test/
├── flight-skill.spec.ts                      스킬 전 구간
├── flight-types.spec.ts                      카드 문구·제한·dedupe
├── flight-nlu.spec.ts                        파싱·날짜·호스트·시각
└── fake-flight-provider.ts                   FLIGHT_PROVIDER 대역
```

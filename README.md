# travel-chatbot-app

카카오톡 **여행메이트 그룹챗봇** 스킬 서버. **NestJS + Supabase**.
범위: **호텔 · 항공권 · 관광지 3가지 (gpt-5-mini + 웹 검색)**

**진입점이 하나다.** 오픈빌더에서 시나리오 블록·엔티티를 전부 지웠으므로 봇을 멘션한
모든 발화가 폴백으로 떨어지고, 폴백 블록이 `POST /api/v1/kakao/router` 하나를 부른다.
무엇을 묻는지는 URL 이 아니라 **발화**가 정한다 → **[docs/ROUTER.md](docs/ROUTER.md)**

운영: https://bot.nolmoa.com · 라우터: [docs/ROUTER.md](docs/ROUTER.md) · 오픈빌더 설정: [docs/KAKAO-SETUP.md](docs/KAKAO-SETUP.md) · 남은 문제: [docs/HANDOFF.md](docs/HANDOFF.md) · DB: [docs/DB.md](docs/DB.md) · 배포: [docs/DEPLOY.md](docs/DEPLOY.md)

**도메인별 상세 — 발화에서 말풍선까지:** [호텔](docs/HOTEL.md) · [항공권](docs/FLIGHT.md) · [관광지](docs/ATTRACTION.md)

> FastAPI 로 먼저 만들었다가 NestJS 로 전환했다. 전환 기록과 주의점은 [docs/MIGRATION.md](docs/MIGRATION.md).

---

## 빠른 실행

```bash
npm install                   # Node 24 (LTS)
cp .env.example .env          # Supabase 없이도 그대로 뜬다
npm run start:dev             # http://localhost:8000
```

**API 문서(Swagger): http://localhost:8000/docs**

예시 요청이 채워져 있어서 열자마자 _Try it out → Execute_ 로 동작 확인이 된다.
운영에서도 항상 켜져 있다: https://bot.nolmoa.com/docs

```bash
# 스킬 호출 테스트 — 셋 다 같은 URL 이다. 발화가 도메인을 정한다.
for u in "오사카 호텔 추천해줘" "오사카 항공권 찾아줘" "도톤보리 맛집 알려줘"; do
  curl -s -X POST localhost:8000/api/v1/kakao/router \
    -H 'content-type: application/json' \
    -d "{\"userRequest\":{\"utterance\":\"$u\",\"user\":{\"properties\":{\"botUserKey\":\"u1\"}}}}" | jq
done
```

첫 호출은 "찾고 있어요" 가 정상이다 — 검색이 7~30초라 백그라운드로 빠진다.
같은 걸 한 번 더 물으면 카드가 나온다.

`SUPABASE_*` 를 비워두면 **no-op 모드**로 동작한다. DB 적재만 건너뛰고 카카오 응답과 리다이렉트는 정상이라, 오픈빌더 연동을 먼저 확인할 때 쓴다.

```bash
npm test           # 213개
npx tsc --noEmit
```

---

## 무엇을 어떻게 찾는가

고정 데이터가 아니라 **gpt-5-mini 가 웹을 검색해서** 찾는다. 지역 화이트리스트는 없다 —
"방콕", "이스탄불", "도톤보리", 뭐든 물어보면 검색한다.

블록이 없으므로 **무엇을 묻는지부터 서버가 정한다.**

| 발화 | 해석 |
| --- | --- |
| `오사카 호텔 추천해줘` | hotel · 오사카 ← 키워드+사전, **모델 호출 0회** |
| `오사카 호텔 4명 9월 22~24일` | hotel · 오사카 · ignored: 4명, 9월 22~24일 |
| `부산에서 오사카 가는 비행기` | flight · 오사카 · from 부산 ← 지명이 둘이라 모델 |
| `도톤보리 맛집 알려줘` | attraction · 도톤보리(오사카) ← 사전에 없어 모델 |
| `베트남 여행지 추천해줘` | **나라 → 도시를 되묻는다** [다낭][하노이][호치민] |
| `안녕 다들 뭐해?` | 도움말 카드. **모델 호출 0회** |

```
[단톡방] "@여행메이트 오사카 호텔 4명 9월 22~24일 추천해줘"
    ↓
멘션 제거 → 여행 신호 확인(정규식)  ── 없으면 도움말 [끝, 0원]
    ↓
의도·지역 해석 ─ 캐시/키워드+사전 ─→ (모델 호출 없음)
    │
   미스 → gpt-5-nano (툴 없음, minimal, 4초 컷)
    ↓   { intent: hotel, place: 오사카, ignored: [4명, 9월 22~24일] }
지역 정규화 → place_id (사전 → place_aliases → 모델 → 원문 등록)
    ↓
search_results 조회 ─ 히트 ─→ listCard 5줄 + 고지 즉시 응답 (~50ms)
    │
   미스 → pending 선점 (동시 요청은 여기서 하나로 묶인다)
    ↓
useCallback 응답 (~100ms)  "오사카 호텔을 찾고 있어요 🔍"
    ↓  ← 여기서 카카오와의 5초 예산은 끝난다
[백그라운드]
  gpt-5-mini + web_search  →  후보 30곳 수집    (구조화 출력)
  gpt-5-mini               →  가격·위치·평점 비교 → 상위 20곳 (구조화 출력)
  예약 URL → 애드픽 커미션 링크 변환 · clickId 발급 · DB 적재
  search_results 에 20건 저장 (5건씩 4페이지로 낸다)
    ↓
POST callbackUrl → listCard 도착 (합쳐서 7~30초)
```

### ⚠️ 날짜·인원은 검색에 반영되지 않는다

캐시를 **지역**(항공권은 노선·왕복여부)으로만 가른다. 날짜까지 키에 넣으면 캐시가 거의
안 맞아 질문 하나가 곧 AI 호출 하나가 된다.

대신 **반영하지 않았다는 사실을 카드 아래에 반드시 적는다.**

```
날짜·인원(4명, 9월 22일~24일)은 반영되지 않았어요.
```

> 이건 타협이 아니라 **전제 조건**이다. 고지 없이 날짜를 무시한 결과를 주면 그 날짜에
> 예약 불가한 호텔과 다른 가격이 나오고, 사용자는 속았다고 느낀다.

### ⚠️ 오픈빌더에서 콜백을 켜야 한다

**이건 코드로 못 한다.** 오픈빌더 → 해당 스킬 블록 → **콜백 사용** 을 직접 켜야 한다.

켜져 있으면 카카오가 요청에 `userRequest.callbackUrl` 을 실어 보낸다. 이 필드의 존재 여부가 "콜백을 써도 되는가"의 유일한 판단 근거다 ([skill-payload.dto.ts](src/modules/kakao/dto/skill-payload.dto.ts)). 꺼진 상태에서 `useCallback` 을 보내면 사용자는 **아무 말풍선도 못 받는다.**

> ⚠️ **그룹챗봇이 콜백 푸시를 실제로 받는지는 검증되지 않았다.** 팀톡방에서 확인하고,
> 안 되면 폴백 블록의 [콜백 사용] 을 끄면 된다 — 코드가 자동으로 "다시 물어봐 주세요"
> 경로로 간다.

콜백이 꺼져 있으면 자동으로 폴백한다: "찾고 있어요, 30초 뒤에 다시 물어봐 주세요" 로 넘기고 백그라운드에서 검색해 캐시에 넣는다. 두 번째 요청부터는 캐시에서 바로 나간다.

### 검색이 되는지 확인하려면

라우터 응답으로는 **성공·실패를 알 수 없다.** 검색을 기다리지 않고 응답하므로 늘
"찾고 있어요" 다. 키가 틀렸든 OpenAI 가 죽었든 응답은 똑같다.

그래서 **같은 로직을 동기로 돌리는 진단 엔드포인트**를 따로 뒀다. 둘 다 `DEBUG_TOKEN`
이 비어 있으면 **404** 다.

```bash
# ① 해석만 — 싸고 빠르다. "왜 도움말이 나오지?" 를 가릴 때 여기부터 본다
curl -s -X POST https://bot.nolmoa.com/api/v1/debug/parse \
  -H 'content-type: application/json' -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"utterance":"오사카 호텔 4명 9월 22~24일 추천해줘"}' | jq
```

```json
{
  "intent": { "intent": "hotel", "place": "오사카", "from": null,
              "tripType": "rt", "ignored": ["4명", "9월 22일~24일"] },
  "place": { "id": 12, "canonicalName": "오사카", "slug": "osaka", "kind": "city", "iata": "KIX" },
  "cacheKey": "hotel:12",
  "timing": { "parseMs": 780, "totalMs": 910 }
}
```

`intent` 가 unknown 인지, `place` 를 못 뽑은 건지, 지역이 엉뚱하게 정규화된 건지가
여기서 갈린다. **셋은 완전히 다른 문제다.**

```bash
# ② 전체 파이프라인 — 검색까지 끝까지 돌린다 (7~30초, OpenAI 요금)
curl -s -X POST https://bot.nolmoa.com/api/v1/debug/search \
  -H 'content-type: application/json' -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"utterance":"오사카 호텔 추천해줘"}' | jq .response
```

**사용자에게 실제로 배달되는 말풍선 JSON 을 그대로** 돌려준다.

> ⚠️ 라우터의 **즉시 응답과는 다르다.** 캐시 미스면 거기서는 `useCallback` 만 나가고
> 이 카드는 잠시 뒤 **콜백으로** 배달된다 — 여기 나오는 건 그 콜백 본문이다.

**조립은 운영과 같은 코드를 태운다.** 제목 40자 잘림, 설명 문구, 줄 링크, 버튼·고지
말풍선까지 동일하다 — 진단용으로 비슷한 걸 따로 만들면 검증이 되지 않는다.
**캐시를 읽지도 쓰지도 않고**, 통계(`recommendations`)에도 아무것도 쓰지 않는다
(진단 호출이 섞이면 전환율 집계가 틀어진다). `clickId` 는 인메모리에 남으므로
**줄 링크를 눌러 이동까지 확인**할 수 있다.

> ⚠️ 호출 한 번이 곧 OpenAI 요금이다. `/docs` 가 공개돼 있으므로 **운영에서는
> `DEBUG_TOKEN` 을 반드시 채운다.**

### "더 보기" — 버튼이 커서를 들고 다닌다

listCard 는 5줄이 한계다. 그래서 **찾는 개수와 보여주는 개수를 분리했다** —
`RESULT_MAX_ITEMS`(기본 20)만큼 찾아 **한 행에 통째로 저장**하고, 카드에는 5줄씩 끊어
최대 4페이지로 낸다. **2페이지를 위해 AI 를 다시 부르지 않는다.**

서버는 "누가 어디까지 봤는지" 를 기억하지 않는다. 버튼이 커서를 싣는다.

```json
{ "label": "더 보기", "action": "block", "blockId": "<폴백 블록>",
  "messageText": "오사카 호텔 더 보기",
  "extra": { "cache_key": "hotel:12", "offset": 5 } }
```

`blockId` 는 설정(`KAKAO_BLOCK_ID_FALLBACK`)이 비어 있으면 **요청이 알려준
`userRequest.block.id`** 를 쓴다. 라우터를 부른 게 곧 폴백 블록이므로 그게 정답이고,
블록을 다시 만들어 ID 가 바뀌어도 저절로 따라간다.

| 방식 | 어떻게 | 한계 |
|---|---|---|
| `block` (기본) | `extra: { cache_key, offset }` → 서버가 `action.clientExtra` 로 받는다 | 서버가 상태를 안 들고 4페이지 |
| `message` | 평범한 메시지 버튼 (`"오사카 호텔 더 보기"`) | 커서를 못 실어 **서버가 발화자별로 30분 기억** |

⚠️ **그룹챗방에서 `action: "block"` 이 되는지 확인되지 않았다.** itemCard 가 안 됐던
전례가 있다. 버튼을 눌렀는데 아무 반응이 없으면 `MORE_BUTTON_STYLE=message` 로 내려라.

⚠️ **다음 페이지가 없으면 버튼을 달지 않는다.** 남은 게 없는데 달면 눌러도 같은 5개가
다시 나오고, 사용자는 그걸 고장으로 읽는다.

### 카드 이미지는 어디서 오나

**모델은 이미지 주소를 모른다.** `web_search` 는 텍스트 스니펫을 주고 거기에 이미지 URL 은 없다. 시키면 그럴듯한 CDN 주소를 지어내고, 그건 카드에 깨진 자리만 남긴다.

그래서 **예약 페이지를 직접 읽는다** ([thumbnail.ts](src/modules/hotel/thumbnail.ts)). 사이트마다 사정이 달라 3단으로 내려간다:

| 층 | 무엇을 보나 | 실측 |
| --- | --- | --- |
| `og` | `og:image` / `twitter:image` | hotels.com ✅ |
| `ld` | JSON-LD 의 `image` | 사이트마다 |
| `photo` | 본문에서 **크기가 박힌** 사진 URL (`_R_960_660_`, `1200x800`) | trip.com ✅ (SPA 라 og 태그가 없다) |

⚠️ **본문 이미지를 무작정 집으면 로고가 박힌다.** 그래서 photo 층은 URL 이 스스로 사진 크기를 밝히는 것만 받고, `og:image` 라도 경로에 `logo`·`default`·`placeholder` 가 있으면 건너뛴다 — 마이리얼트립이 상세 페이지에 사이트 로고를 og:image 로 박아둔다. 다섯 줄이 전부 같은 로고가 되느니 이미지가 없는 게 낫다.

뽑은 주소는 살아 있는지 확인하고 넣는다. trip.com CDN 처럼 **HEAD 에 `content-type` 을 안 주는** 곳이 있어서, 200 이면 받고 HEAD 자체를 막으면 1KB 만 받아서 다시 본다.

콜백 경로에서만 도는 코드라 카카오 5초 예산과 무관하고, 결과는 검색 캐시에 같이 저장되므로 같은 도시를 다시 물어도 페이지를 또 읽지 않는다. `trace=true` 의 `counts.thumbnails` / `thumbnailSources` 로 층별 성공률을 볼 수 있다.

#### 관광지는 페이지가 없어서 위키백과를 본다

관광지에는 긁어올 예약 페이지 자체가 없다. 그래서 [`attraction-image.ts`](src/modules/attraction/attraction-image.ts) 가 위키백과 API 에서 받아온다 — 키가 필요 없고 무료이며, **구조화된 API 라 모델이 지어낼 자리가 없다**(지도 링크를 우리가 만드는 것과 같은 이유다).

`ko` → `en` 순으로 본다. 한국어 문서만 보면 동남아가 통째로 비기 때문이다 — 실측 커버리지가 **62% → 87%** 로 올라간다(세부는 0/5 → 4/5). 영어판 검색어로 쓸 영문명(`name_en`)은 모델에게 같이 받는다.

⚠️ **엉뚱한 사진은 사진이 없는 것보다 나쁘다.** 사용자는 카드 사진을 그 장소라고 믿는다. 그래서 문서 제목이 관광지 이름과 **포함 관계**일 때만 받고(느슨하게 하면 "유니버설 스튜디오 재팬" 이 싱가포르 사진을 물고 온다), 도시 문서로 떨어진 경우는 버린다(그 대표 이미지는 **위치 지도**다). 사진이 없는 줄은 그냥 사진 없이 나가고, 그것 때문에 관광지를 목록에서 빼지는 않는다.

⚠️ **저작권.** 위키미디어 사진은 대부분 CC BY-SA 라 엄밀히는 사진마다 저작자 표시가 필요한데, listCard 한 줄에는 링크가 하나뿐이고 그 자리는 지도가 써야 한다. 지금은 카드 하단 "사진 출처: 위키미디어" 버튼뿐이다 — 정식 표시가 아니므로 카드 밖에서 쓸 때는 [ATTRACTION.md](docs/ATTRACTION.md) 를 먼저 보라.

### 비용과 안전장치

| 장치                   | 하는 일                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| 1차 필터 (정규식)      | 여행과 무관한 잡담은 **모델을 아예 안 부른다** — 단톡방 발화의 대부분이다      |
| 키워드 + 도시 사전     | "오사카 호텔 추천해줘" 는 모델 없이 끝난다 (0ms · 0원)                          |
| 의도 캐시              | 같은 문장은 두 번 해석하지 않는다 (`INTENT_CACHE_TTL_MINUTES`, 7일)             |
| 지역 별칭              | "동경"·"osaka"·"오사카시" 가 한 `place_id` 로 모인다 — 캐시 적중률의 전부       |
| 검색 결과 저장         | 같은 지역을 100명이 물어도 OpenAI 호출은 1회 (`*_CACHE_TTL_MINUTES`)            |
| 메모리 단              | DB 가 죽어도 저장소는 산다. 저장소가 죽으면 요청 하나가 곧 요금이다             |
| `pending` 선점         | 동시 요청을 검색 1회로 묶는다 (Redis 없이 Postgres 만으로)                      |
| 더보기 = 저장된 행     | 2~4페이지는 AI 호출 0회                                                         |
| 호스트 허용 목록       | 모델이 지어낸 예약 URL 을 버린다 — 트립닷컴·마이리얼트립·클룩·호텔스닷컴만 통과 |
| 썸네일 수집·검증       | 예약 페이지에서 대표 이미지를 긁고, 살아 있는 주소만 카드에 넣는다              |
| 두 호출 다 구조화 출력 | 모델이 결과 대신 "진행할까요?" 라고 되묻을 자리를 없앤다                        |

---

## 엔드포인트

| 메서드 | 경로 | 용도 |
| ------ | ---- | ---- |
| POST | `/api/v1/kakao/router` | **유일한 스킬 진입점.** 폴백 블록이 부른다 |
| GET | `/r/{clickId}` | 클릭 카운트 → 애드픽/구글맵 302 (DB 왕복 1회) |
| GET | `/health` · `/health/db` | 앱 생존 · Supabase 연결 진단 |
| POST | `/api/v1/debug/parse` | 발화 해석만 (`DEBUG_TOKEN`) |
| POST | `/api/v1/debug/search` | **동기 전체 파이프라인** — 실제 말풍선 그대로 (`DEBUG_TOKEN`) |
| GET | `/docs` | Swagger (운영에서도 켜져 있다) |

예전의 `hotels/recommend` · `flights/search` · `attractions/recommend` · `fallback` 은
**없앴다.** 오픈빌더에 블록이 없어 아무도 부를 수 없고, 열어두면 "쓰이지 않는데 살아
있는 경로" 가 된다. 도메인 코드는 그대로 남아 라우터가 내부에서 부른다.

### 링크는 이렇게 만들어진다

호텔 마스터를 소유하지 않는다. **AI/크롤링이 원본 호텔 주소를 찾아오고, 애드픽 API 가 그걸 커미션 링크로 바꾼다.**

```
AI 검색 → 원본 주소 (kr.trip.com/hotels/detail?id=12345)
   ↓ GET biz.adpick.co.kr/api/{key}/link?url=...   (결과는 affiliate_links 에 캐시)
커미션 링크 (link.adpick.co.kr/xxxxxxxx)
   ↓ 카드 줄 링크는 이걸 직접 가리키지 않는다
/r/{clickId} → click_count + 1 → 302 → 커미션 링크
```

**리다이렉트를 한 홉 끼우는 이유**: 카카오 링크는 브라우저를 바로 열어 우리 서버로 아무 신호가 오지 않는다. 애드픽 링크를 카드에 직접 박으면 "사용자가 어떤 호텔을 골랐는지"를 영영 알 수 없다.

**캐시가 필요한 이유**: 애드픽 API 는 분당 60회 제한이고 180일 무클릭 링크를 삭제한다. 호텔 5건이면 요청 1건에 5회를 쓴다.

**추적은 2층 구조다.**

|                                   | 범위                          | 어디서 확인                             |
| --------------------------------- | ----------------------------- | --------------------------------------- |
| `p_data` = `h_{sha1(source_url)}` | 호텔 단위 (링크 생성 시 고정) | 애드픽 성과 데이터 API                  |
| `clickId`                         | 노출 1건 단위                 | 우리 `recommendation_items.click_count` |

**원본 주소는 DB에만 남고 사용자에게는 노출되지 않는다.**

### 응답은 `listCard` 한 장

호텔 5곳을 한 화면에서 위아래로 비교할 수 있어야 하므로 캐러셀(좌우 스와이프) 대신 [listCard](https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format) 를 쓴다.

```json
{
  "listCard": {
    "header": { "title": "오사카 호텔 추천 5곳" },
    "items": [
      {
        "title": "호텔 한큐 리스파이어 오사카",
        "description": "1박 172,000원~ · 평점 9.1 · 우메다",
        "imageUrl": "https://…",
        "link": { "web": "https://…/r/6kCgoISYegpS" }
      }
    ],
    "buttons": [
      {
        "label": "더 보기",
        "action": "block",
        "blockId": "6a90f3a995f722d77d9fd0e6",
        "messageText": "오사카 호텔 더 보기",
        "extra": { "cache_key": "hotel:12", "offset": 5 }
      }
    ]
  }
}
```

**각 줄의 `link.web` 이 호텔마다 다른 `clickId`** 를 가리킨다. 줄 전체가 클릭 영역이라 별도 버튼 없이도 어떤 호텔을 골랐는지 추적된다.

카카오 제약은 [`templates.ts`](src/modules/kakao/templates.ts) 에서 처리한다 — items **최대 5개**, 버튼 최대 2개, 라벨 14자. 그래서 서비스는 **애드픽 API 를 호출하기 전에** 이번 페이지의 5개로 자른다 — 이번 카드에 안 나갈 호텔까지 변환하면 분당 60회 제한을 헛되이 쓴다.

카드 **뒤에 고지 말풍선이 붙을 수 있다** — 무시한 조건·출발지 추정·예전 정보가 있을
때만이다. header 40자·설명 40자에는 그 말이 안 들어가는데, 없으면 사용자가 날짜까지
반영된 결과로 믿는다. 앞에 세우면 결과를 가리므로 **카드가 먼저다.**

### 항공권도 `listCard` 다

> 전체 흐름·프롬프트·실패 진단은 **[docs/FLIGHT.md](docs/FLIGHT.md)**.

원래는 `itemCard` 캐러셀이었다. 항공권 1건을 고르려면 항공사·편명·시각·소요·경유·가격이
다 필요한데 listCard 한 줄은 40자뿐이라, key-value 5줄을 쌓을 수 있는 itemCard 가 맞았다.

**그런데 그룹챗봇이 itemCard 를 못 그린다 — 말풍선이 통째로 사라진다.** 팀톡방에서
항공권만 무응답이던 원인이 이것이다. 호텔·관광지가 같은 방에서 멀쩡한 건 listCard 라서다.

그래서 정보 밀도를 포기하고 모양을 맞췄다. 한 줄에 들어갈 것만 남긴다.

```json
{
  "listCard": {
    "header": { "title": "서울→오사카 항공권 5편" },
    "items": [
      {
        "title": "대한항공 KE723 · 289,000원",
        "description": "10/3(토) 09:20→11:00 · 1시간 40분 · 직항",
        "link": { "web": "https://…/r/Ab3xY9kQ2mZp" }
      }
    ],
    "buttons": [{ "label": "더 보기", "action": "block", "…": "…" }]
  }
}
```

**가격을 제목에 둔다.** 항공편을 고르는 첫 번째 축이고, listCard 는 제목이 설명보다
눈에 먼저 들어온다. 왕복이면 두 구간의 날짜·출발 시각만으로 40자가 차서 **도착 시각과
소요 시간을 버린다** — 대신 직항 여부는 남긴다. 경유가 몇 번인지는 예약 페이지를 열기
전에 알아야 거르기 때문이다.

**호텔과 다른 점 세 가지**

| | 호텔 | 항공권 |
| --- | --- | --- |
| 캐시 키 | `hotel:{place_id}` (24시간) | `flight:{from}>{to}:{rt\|ow}` (6시간) — 운임이 빨리 상한다 |
| 왜 키가 다른가 | 지역 하나 | **출발지·도착지·왕복여부**가 다 들어가야 한다. 지역만으로 잡으면 왕복 요청에 편도 결과가 나간다 |
| 항목의 신원 | `source_url` (호텔 1곳 = 주소 1개) | 편명 + 출발시각 — **여러 편이 같은 노선 검색 페이지를 공유한다** |

마지막 줄이 중요하다. 호텔처럼 주소로 중복을 지우면 **줄이 하나만 남는다.**

### ⚠️ 항공권 가격은 확정 운임이 아니다

실시간 운임 API 가 없다. 웹 검색으로 얻는 건 "그 노선이 대략 얼마인가"이지 지금 살 수 있는 가격이 아니다. 그래서

- **날짜를 검색에 넘기지 않으므로** 특정 날짜의 운임이 아니라 "최근 기준 일반적인 요금대" 다. 그 사실이 고지에 적힌다
- 실제 금액은 예약 페이지에서 확정된다

서버 로그의 `searchCalls` 가 0 이면 모델이 웹 검색을 안 하고 기억으로 답한 것이라 그
가격은 더더욱 믿을 수 없다.

GDS·항공사 API 가 붙으면 `FLIGHT_PROVIDER` 만 갈아끼우면 된다 — 서비스와 카드 조립 코드는 그대로다.

### ⚠️ 출발지를 말하지 않으면 서울 출발로 본다

"오사카 항공권" 처럼 출발지를 빼고 말하는 게 보통이다. 되묻는 대신 `FLIGHT_DEFAULT_ORIGIN_*`(기본 서울/ICN)에서 출발한다고 보고, **안내 말풍선에 "서울 출발 기준이에요" 를 적는다.** 부산에서 출발하려던 사람이 그 한 줄을 보고 고쳐 말할 수 있어야 한다 — 조용히 추측하면 잘못된 노선의 가격을 믿게 된다.

발화 해석기는 이 추측을 하지 않는다. 출발지가 없으면 `null` 을 주고, 채우는 건
`SearchService` 다 (`originAssumed` 플래그가 그 사실을 고지 말풍선까지 들고 간다).


### 관광지는 `listCard` + 구글맵

> 전체 흐름·프롬프트·실패 진단은 **[docs/ATTRACTION.md](docs/ATTRACTION.md)**.

관광지는 **예약이 없는 도메인**이다. 그래서 호텔·항공권에서 가장 복잡했던 부분(애드픽 변환, 허용 호스트, 죽은 링크 처리)이 통째로 빠진다.

**링크를 모델에게 받지 않고 우리가 만든다.**

```
mapsUrl('오사카성', '오사카')
→ https://www.google.com/maps/search/?api=1&query=오사카성%20오사카
```

구글이 공개한 URL 규약에 이름만 끼워 넣으므로 **모델이 주소를 지어낼 자리가 없다.** 검증할 것도, 404 도 없다. (⚠️ 좌표는 쓰지 않는다 — LLM 의 좌표는 그럴듯하고 자주 틀린다. 엉뚱한 곳에 핀이 꽂히는 건 이름으로 검색되는 것보다 나쁘다)

수수료가 없는데도 `/r/{clickId}` 는 그대로 거친다. **어떤 관광지를 눌렀는지**는 알아야 하기 때문이다 — 호텔에서 리다이렉트를 끼운 것과 같은 이유다.

```
오사카 관광지 5곳
  오사카성            | 1,200엔 · 2시간 · 난바
  도톤보리            | 무료 · 1시간 30분 · 난바
  우메다 스카이 빌딩     | 1,500엔 · 1시간 30분 · 우메다
  [더 보기] [사진 출처: 위키미디어]
```

발화 해석기와 지역 정규화는 **세 도메인이 공유한다.** "오사카 호텔" 을 물어본 사람이
"오사카 관광지" 를 물으면 지역 해석이 공짜다 (같은 `place_id` 에 닿는다).

### ⚠️ 입장료를 원화로 환산시키지 않는다

처음엔 "원화로 환산해서 적어라" 로 시켰다. 실측 결과가 이랬다:

| 관광지 | 실제 | 모델이 준 값 |
|---|---|---|
| 오사카성 | 1,200엔 | **약 5,760원** |
| 카이유칸 | 2,700엔 (≈27,000원) | **약 2,700원** ← 엔화 숫자를 원화 칸에 그대로 |

**모델은 환율 계산을 못한다.** 검색 결과의 숫자를 옮기는 건 잘한다. 그래서 현지 통화 그대로 받아 `1,200엔`, `500바트` 로 적는다. 통화를 모르면 금액을 아예 버리고 `유료` 라고만 쓴다 — `1,200` 만 보여주면 한국인은 원으로 읽고, 엔이었다면 10배를 틀리게 읽는다.

숫자 자체의 정확도는 여전히 보장되지 않는다(실측에서 오사카성이 600엔으로 나온 적도 있다). 예약이 아니라 방문 계획이라 오차의 대가는 작지만, 참고값으로 봐야 한다.


---

## 시크릿 관리

`.env` 와 GitHub Secrets 는 **대체재가 아니라 용도가 다르다.**

|                               | 언제 읽히나                | 무엇을 넣나 |
| ----------------------------- | -------------------------- | ----------- |
| 로컬 `.env` (gitignore)       | 내 PC 에서 개발할 때       | 개발용 값   |
| **서버 `.env`** (`chmod 600`) | **운영 컨테이너 실행 중**  | 진짜 키     |
| GitHub Secrets                | GitHub Actions 실행 중에만 | SSH 배포 키 |

**GitHub Secrets 는 런타임 저장소가 아니다.** 서버에서 도는 컨테이너는 읽지 못한다.

| 값                          | 위험도                                     |
| --------------------------- | ------------------------------------------ |
| `SUPABASE_SERVICE_ROLE_KEY` | **최상** — RLS 를 우회한다                 |
| `ADPICK_API_KEY`            | 높음 — 남이 쓰면 내 계정으로 링크가 생성됨 |
| `KAKAO_SKILL_TOKEN`         | 중간 — 없으면 스킬 URL 을 아무나 호출      |

> 애드픽은 API 키가 **URL 경로**에 들어간다(`/api/{apikey}/link`). 예외 메시지에 요청 URL 이 담기므로, 그냥 로깅하면 키가 로그와 `affiliate_links.error` 에 남는다. [`adpick.service.ts`](src/modules/adpick/adpick.service.ts) 의 `redact()` 가 `***` 로 가린다.

---

## Supabase 셋업

1. 프로젝트 생성 — **리전 Seoul** 권장
2. SQL Editor 에 [`0001_init.sql`](supabase/migrations/0001_init.sql) → [`0002_flight.sql`](supabase/migrations/0002_flight.sql) → [`0003_attraction.sql`](supabase/migrations/0003_attraction.sql) → [`0004_router.sql`](supabase/migrations/0004_router.sql) 순서로 붙여넣고 실행 (재실행 안전)
3. `.env` 에 `SUPABASE_URL` 과 `SUPABASE_SERVICE_ROLE_KEY` 입력 → [자세히](docs/DEPLOY.md)

시드 스크립트는 없다. **호텔·항공권·관광지 데이터는 전부 provider 가 런타임에 만든다.**

### 테이블 (스키마 10개 · 코드가 쓰는 건 9개 — 세 도메인 공용)

| 그룹 | 테이블 |
| --- | --- |
| 지역 | `places` · `place_aliases` |
| 결과·캐시 | `search_results` · `intent_cache` · `affiliate_links` |
| 행동 로그 | `users` · `messages` · `recommendations` · `recommendation_items` |

위 9개는 **전부 코드가 실제로 읽고 쓴다.** 빈 껍데기는 하나뿐이다 —
`search_cache`(0001)는 라우터 이전 구조의 잔재로, `search_results`(0004)가 대체했다.
이제 읽지도 쓰지도 않지만 롤백을 위해 남겨뒀고, 그래서 **헬스체크도 찌르지 않는다**
(누가 드롭해도 서버는 정상으로 보고한다).

흐름: 발화 1건 → `messages` 1행 → `search_results` 1행(20건, 여러 사람이 공유) →
`recommendations` 1행(카드 1장) → `recommendation_items` N행(노출) → 클릭 시 `click_count` 증가

**`places` 를 미리 채우지 않는다.** 질의를 받을 때마다 모르는 지역을 등록하며 자란다.
"오사카" / "osaka" / "오사카시" 가 같은 `place_id` 로 모이는 것이 캐시 적중률의 전부이고,
세부 지역("도톤보리")은 자기 행을 갖고 `parent_id` 로 도시에 매달린다.

**호텔 마스터 테이블은 없다.** 매번 AI 로 새로 받는 목록이라 이름으로는 같은 호텔을 못
묶는다. 호텔 신원은 `source_url` 이고 `affiliate_links` 가 그 역할을 한다.

**항공권·관광지도 같은 테이블을 쓴다.** `domain`/`kind` 컬럼이 셋을 가른다 — 도메인마다
테이블을 복제하면 "이번 주 클릭 수" 같은 질문이 전부 union 이 되고, 클릭 추적 경로
(`/r/{clickId}`)가 어느 테이블을 볼지부터 알아내야 한다. 컬럼 이름이 호텔 시절 그대로인
것들(`recommendation_items.hotel_name` 등)의 의미는
[`0002_flight.sql`](supabase/migrations/0002_flight.sql) 주석에 정리돼 있다.

ERD와 컬럼별 설명은 **[docs/DB.md](docs/DB.md)**.

---

## 카카오 오픈빌더 연결

**블록을 만들지 않는다.** 시나리오 블록·나의 엔티티·대표 명령어를 전부 지운 상태가 전제다.

1. **스킬** 1개 등록 — `https://bot.nolmoa.com/api/v1/kakao/router`
2. **헤더** `X-Skill-Token` = `.env` 의 `KAKAO_SKILL_TOKEN` ← 빠뜨리면 401
3. **폴백 블록** → 그 스킬 연결 + 봇 응답을 **스킬데이터**로
4. **폴백 블록의 [콜백 사용] 을 켠다** ← 안 켜면 첫 검색 결과가 사용자에게 안 간다 ([왜](#-오픈빌더에서-콜백을-켜야-한다))
5. 봇 입장 / 도움말 블록에 사용법 안내
6. 배포 (HTTPS 필수, **응답 5초 제한**)

블록이 하나도 없으므로 **봇을 멘션한 모든 발화가 폴백으로 떨어진다.** 그게 이 구조의
전제이자 장점이다 — 사용자가 명령어를 외우지 않아도 되고, 엔티티 목록(237개 도시)을
오픈빌더와 코드 양쪽에서 맞춰둘 필요도 없다.

### 지역은 어떻게 찾는가

위에서 걸리면 아래는 안 본다.

| 순서 | 수단 | 비용 | 무엇을 잡나 |
|---|---|---|---|
| 1 | 프로세스 메모리 · `place_aliases` | 0ms · 0원 | 전에 누군가 물어본 지역 |
| 2 | 도시 사전 [`city-table.ts`](src/modules/places/city-table.ts) | 0ms · 0원 | 237개 도시 + 별칭(동경·Cebu·싱가폴) + 공항 코드 |
| 3 | 모델 (gpt-5-nano) | ~1초 · 유료 | 사전에 없는 곳(도톤보리·해운대·시부야), 오타 |
| 4 | 원문 그대로 등록 | 0원 | 모델까지 실패했을 때. **되묻지 않는다** |

4번이 규칙이다. **지역을 검증하지 않는다** — "그런 도시 없어요" 로 막지 않고 일단
검색해 본다. 사용자는 지명을 제대로 말했는데 우리가 모르는 경우가 대부분이고, 틀렸다면
결과가 비는 것으로 드러난다.

⚠️ **도시 이름을 품은 흔한 말은 문장에서 긁지 않는다.** "사파리 투어" 안에는 **파리**가,
"테니스 코트" 안에는 **니스**가 들어 있다. 최장 일치로는 못 막는다(더 긴 별칭이 아예
없다). 훑기 전에 그 말들을 지운다. 같은 이유로 "빈 방"·"어느 나라"·"퍼스트 클래스"는
도시로 보지 않는다.

⚠️ **지명이 둘이면 사전으로 끝내지 않는다.** "서울에서 세부 가는" 은 어느 쪽이 목적지인지
사전으로 못 가리므로 모델에 넘긴다. 틀린 지역으로 검색하는 것보다 낫다.

⚠️ **봇 멘션을 먼저 떼어낸다.** 봇 이름에 "여행" 이 들어 있어서, 안 떼면
"@여행메이트 안녕 다들 뭐해?" 같은 인사말이 1차 필터를 통과해 모델 호출이 된다 —
방 인원수만큼 곱해진다.

---

## 구조

```
src/
├── common/
│   ├── booking-url.ts                 예약 링크 호스트 검증 / 한국어 페이지 변환 (호텔·항공권 공용)
│   ├── maps-url.ts                    구글맵 링크 생성 (관광지)
│   └── guards/skill-token.guard.ts    X-Skill-Token (비우면 검증 안 함)
├── config/
│   ├── app.config.ts                  환경변수 → AppConfig
│   ├── database.config.ts             DB 활성 판단, 기대 테이블 목록
│   └── config.module.ts               전역 제공
├── modules/
│   ├── kakao/                         카카오 진입점 — 엔드포인트가 하나뿐이다
│   │   ├── router.controller.ts       POST /api/v1/kakao/router
│   │   ├── cards.ts                   사용자가 읽는 문구 (도움말·고지·실패)
│   │   ├── paging.ts                  커서·페이지 자르기·더보기 버튼
│   │   ├── templates.ts               listCard 빌더 (길이·개수 제한)
│   │   └── dto/skill-payload.dto.ts   오픈빌더 요청 접근자 (멘션 제거 포함)
│   ├── intent/intent.service.ts       의도·지역·무시한 조건 추출 (캐시 → 키워드 → 모델)
│   ├── places/                        지역 정규화 — 캐시 적중률이 여기서 결정된다
│   │   ├── places.service.ts          사전 → 별칭 → 모델 → 원문 등록
│   │   └── city-table.ts              도시 사전 237개 (+ 공항 코드)
│   ├── search/                        도메인을 모르는 오케스트레이션
│   │   ├── search.service.ts          캐시 조회 · 선점 · 백그라운드 검색 · 페이지 · 콜백
│   │   ├── search-store.service.ts    저장소 2단(메모리 → Supabase) + single-flight
│   │   └── search.types.ts            SearchDomain 계약 (도메인이 구현한다)
│   ├── hotel/ flight/ attraction/     도메인 — "어떻게 찾고 어떻게 한 줄로 그리는가"
│   │   ├── *.service.ts               search() + rows() 두 가지만
│   │   ├── *.types.ts                 항목 타입·카드 문구·PROVIDER 토큰
│   │   └── providers/openai.provider.ts   gpt-5-mini 2단 호출
│   ├── openai/openai.service.ts       Responses API 클라이언트
│   ├── adpick/adpick.service.ts       커미션 링크 생성 (키 마스킹·동시성 제한)
│   ├── affiliate/affiliate.service.ts 캐시 우선 링크 해석
│   ├── debug/debug.controller.ts      /api/v1/debug/parse · /search (DEBUG_TOKEN)
│   ├── redirect/redirect.controller.ts  /r/{clickId}
│   ├── health/health.controller.ts    /health, /health/db
│   └── database/                      Supabase (@Global)
│       ├── supabase.service.ts        없으면 no-op
│       ├── memory-store.service.ts    no-op 모드 리다이렉트 폴백
│       └── repositories/              실패해도 예외를 올리지 않음
├── app.module.ts
└── main.ts
```

### 설계 규칙 4가지

- **라우터는 도메인을 모르고, 도메인은 서로를 모른다.** 네 번째 도메인이 생겨도 `search.service.ts` 는 그대로다 — 도메인은 [`SearchDomain`](src/modules/search/search.types.ts) 네 가지(검색·판별·머리글·줄 그리기)만 구현한다.
- **DB 실패가 챗봇 응답을 죽이지 않는다.** repository 는 예외 대신 `null` 을 반환하고, 라우터는 어떤 예외에도 200 + 안내 문구를 돌려준다. 카카오에 500을 주면 사용자에게는 원인 불명의 오류만 뜬다.
- **애드픽 변환이 실패해도 카드는 나간다.** 원본 주소로 폴백한다 — 수익화는 못 해도 사용자는 호텔을 본다. 실패 사유는 `affiliate_links.error` 에 남는다.
- **provider 만 갈아끼우면 데이터 소스가 바뀐다.** `HotelProvider.search()` 는 async 라 크롤링/LLM 으로 교체할 때 service 를 안 고쳐도 된다. 단 그 시점엔 5초를 넘기므로 카카오 **콜백(useCallback)** 전환이 필요하다.

---

## 배포

`main` 에 push 하면 **테스트 → SSH → 서버 재빌드 → 헬스체크** 가 자동으로 돈다.
전체 절차·트러블슈팅은 [docs/DEPLOY.md](docs/DEPLOY.md).

```
인터넷 → :443 Caddy (TLS 자동) → app:8000 (Nest, 비루트) → Supabase
```

---

## 다음 단계

### 팀톡방에서 검증해야 한다 (셋 다 폴백이 준비돼 있다)

- [ ] **콜백 푸시가 실제로 도착하는가** → 안 되면 폴백 블록의 [콜백 사용] 을 끈다
- [ ] **`action: "block"` 버튼이 동작하는가** → 안 되면 `MORE_BUTTON_STYLE=message`
- [ ] **AI 가 20건을 안정적으로 주는가** → 품질이 떨어지면 `RESULT_MAX_ITEMS` 를 10~15로

### 그다음

- [ ] 인기 지역 배치 선(先)채움 — 첫 질문이 늘 30초인 걸 없앤다
- [ ] 만료 캐시 백그라운드 갱신 (지금은 물어본 사람이 예전 결과를 받고 그때 갱신된다)
- [ ] 세부 지역 → 부모 지역 폴백 (도톤보리 결과가 빈약하면 오사카로)
- [ ] 애드픽 API 키 발급 → `.env` 의 `ADPICK_API_KEY` (키만 넣으면 실제 커미션 링크로 전환)
- [ ] 항공권 실시간 운임 API(GDS·항공사) 연동 — 지금은 웹 검색 기반 **예상가**다. `FLIGHT_PROVIDER` 만 갈아끼우면 된다
- [ ] 관광지 사진별 저작권 표시 — 지금은 카드 단위 출처 버튼뿐 ([ATTRACTION.md](docs/ATTRACTION.md))
- [x] 단일 진입점 라우터 (블록·엔티티 없이 발화로 도메인을 가른다)
- [x] 지역 마스터 `places` — 세부 지역(도톤보리)까지 자기 캐시를 갖는다
- [x] `pending` 선점으로 동시 호출 1회 병합
- [x] 20건 저장 → 5건씩 4페이지
- [x] 항공권 카드를 listCard 로 (그룹챗봇이 itemCard 를 못 그린다)
- [x] 날짜·인원 미반영 고지

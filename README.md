# travel-chatbot-app

카카오톡 여행 챗봇 스킬 서버. **NestJS + Supabase**.
현재 범위: **호텔 추천 · 항공권 검색 · 관광지 추천 (gpt-5-mini + 웹 검색)**

운영: https://bot.nolmoa.com · 기획: [docs/PLAN.md](docs/PLAN.md) · DB: [docs/DB.md](docs/DB.md) · 항공권: [docs/FLIGHT.md](docs/FLIGHT.md) · 관광지: [docs/ATTRACTION.md](docs/ATTRACTION.md) · 배포: [docs/DEPLOY.md](docs/DEPLOY.md)

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
# 스킬 호출 테스트 (호텔)
curl -s -X POST localhost:8000/api/v1/kakao/hotels/recommend \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"오사카 호텔 추천해줘","user":{"properties":{"botUserKey":"u1"}}}}' | jq

# 스킬 호출 테스트 (항공권)
curl -s -X POST localhost:8000/api/v1/kakao/flights/search \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"다음달 3일 오사카 왕복 항공권 2명","user":{"properties":{"botUserKey":"u1"}}}}' | jq

# 스킬 호출 테스트 (관광지)
curl -s -X POST localhost:8000/api/v1/kakao/attractions/recommend \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"오사카 관광지 추천해줘","user":{"properties":{"botUserKey":"u1"}}}}' | jq
```

`SUPABASE_*` 를 비워두면 **no-op 모드**로 동작한다. DB 적재만 건너뛰고 카카오 응답과 리다이렉트는 정상이라, 오픈빌더 연동을 먼저 확인할 때 쓴다.

```bash
npm test           # 249개
npx tsc --noEmit
```

---

## 호텔은 어떻게 찾는가

고정 데이터가 아니라 **gpt-5-mini 가 웹을 검색해서** 찾는다. 도시 화이트리스트는 없다 — "방콕", "이스탄불", 뭐든 물어보면 검색한다.

발화 해석도 모델이 한다. 키워드 매칭은 실제 카카오 사용자를 못 버틴다:

| 발화                                          | 결과                |
| --------------------------------------------- | ------------------- |
| `오사카 여행갈건데 4명기준으로 숙소 추천해줘` | `osaka`, guests 4   |
| `오사카 호텔 추천`                            | `osaka` ← 오타 교정 |
| `동경 숙소`                                   | `tokyo` ← 표기 통일 |

```
[사용자] "오사카 여행갈건데 4명기준으로 숙소 추천해줘"
    ↓
발화 캐시 ─ 히트 ─→ (모델 호출 없음)
    │
   미스 → gpt-5-nano 파싱 (툴 없음, minimal, 4초 컷) → { osaka, guests:4 }
    ↓
캐시 조회 ─── 히트 ──→ listCard 즉시 응답 (~50ms)
    │
   미스
    ↓
useCallback 응답 (~100ms)  "방콕 호텔을 찾고 있어요 🔍"
    ↓  ← 여기서 카카오와의 5초 예산은 끝난다
[백그라운드]
  gpt-5-mini + web_search  →  후보 15곳 수집    (구조화 출력)
  gpt-5-mini               →  가격·위치·평점 비교 → 상위 5곳 (구조화 출력)
  예약 URL → 애드픽 커미션 링크 변환
  clickId 발급 + DB 적재
    ↓
POST callbackUrl → listCard 도착 (합쳐서 7~30초)
```

### ⚠️ 오픈빌더에서 콜백을 켜야 한다

**이건 코드로 못 한다.** 오픈빌더 → 해당 스킬 블록 → **콜백 사용** 을 직접 켜야 한다.

켜져 있으면 카카오가 요청에 `userRequest.callbackUrl` 을 실어 보낸다. 이 필드의 존재 여부가 "콜백을 써도 되는가"의 유일한 판단 근거다 ([skill-payload.dto.ts](src/modules/kakao/dto/skill-payload.dto.ts)). 꺼진 상태에서 `useCallback` 을 보내면 사용자는 **아무 말풍선도 못 받는다.**

콜백이 꺼져 있으면 자동으로 폴백한다: "찾고 있어요, 30초 뒤에 다시 물어봐 주세요" 로 넘기고 백그라운드에서 검색해 캐시에 넣는다. 두 번째 요청부터는 캐시에서 바로 나간다.

### 검색이 되는지 확인하려면

스킬 엔드포인트 응답으로는 **성공·실패를 알 수 없다.** 검색을 기다리지 않고 응답하므로 늘 "찾고 있어요" 다. 키가 틀렸든 OpenAI 가 죽었든 응답은 똑같다.

그래서 **같은 로직을 동기로 돌리는 진단 엔드포인트**를 따로 뒀다.

스킬과 **똑같이 발화 하나만** 받아서 파싱부터 검색까지 다 돌리고, **사용자에게 실제로 배달되는 말풍선 JSON 을 그대로** 돌려준다.

> ⚠️ 스킬 엔드포인트의 **즉시 응답과는 다르다.** 캐시 미스면 거기서는 `useCallback` 만 나가고 이 카드는 잠시 뒤 **콜백으로** 배달된다 — 여기 나오는 건 그 콜백 본문이다. 캐시 히트일 때만 스킬 응답 자체와 같다.

```bash
curl -sG https://bot.nolmoa.com/api/v1/debug/hotel-search \
  -H "x-debug-token: $DEBUG_TOKEN" \
  --data-urlencode "utterance=오사카 여행갈건데 4명기준으로 숙소 추천해줘" | jq
```

```json
{
  "version": "2.0",
  "template": {
    "outputs": [
      {
        "listCard": {
          "header": { "title": "오사카 호텔 추천 5곳" },
          "items": [
            {
              "title": "호텔 그란비아 오사카",
              "description": "1박 172,000원~ · 평점 9.1 · 우메다",
              "link": { "web": "https://bot.nolmoa.com/r/Ab3xY9kQ2mZp" }
            }
          ],
          "buttons": [{ "label": "다른 도시 보기", "action": "message", "messageText": "호텔 추천해줘" }]
        }
      }
    ],
    "quickReplies": [{ "label": "도쿄 호텔", "action": "message", "messageText": "도쿄 호텔 추천해줘" }]
  }
}
```

**조립은 `HotelService` 의 같은 코드를 태운다.** 제목 40자 잘림, 설명 문구, 줄 링크, 버튼·퀵리플라이까지 운영과 동일하다 — 진단용으로 비슷한 걸 따로 만들면 검증이 되지 않는다. 도시를 못 알아들으면 되묻기가, 결과가 없으면 그 안내 문구가 나오는 것도 스킬과 같다.

`clickId` 는 인메모리에 남으므로 **줄 링크를 그대로 눌러 애드픽 이동까지 확인**할 수 있다. 응답을 통째로 복사해 오픈빌더 스킬 테스트에 넣어봐도 된다.

#### 진단 정보는 `trace=true`

```bash
curl -sG https://bot.nolmoa.com/api/v1/debug/hotel-search \
  -H "x-debug-token: $DEBUG_TOKEN" \
  --data-urlencode "utterance=오사카 호텔 추천해줘" -d trace=true | jq .debug
```

```json
{
  "ok": true,
  "utterance": "오사카 여행갈건데 4명기준으로 숙소 추천해줘",
  "parsed": { "citySlug": "osaka", "cityName": "오사카", "guests": 4, "nights": null },
  "timings": {
    "parseMs": 780,
    "searchMs": 11240,
    "rankMs": 3380,
    "thumbnailMs": 820,
    "totalMs": 16230
  },
  "counts": {
    "searchCalls": 3,
    "picks": 5,
    "droppedUntrusted": 1,
    "hotels": 4
  },
  "hotels": [
    { "name": "…", "cardDescription": "1박 172,000원~ · 평점 9.1 · 우메다" }
  ],
  "hint": null
}
```

**여기서 진짜 걸리는 시간을 잰다.** 발화 파싱도 호텔 검색도 캐시를 타지 않고 매번 실제로 부르며, 통계(`recommendations`)에는 아무것도 쓰지 않는다(진단 호출이 섞이면 전환율 집계가 틀어진다). 실패하면 `debug.ok: false` 와 에러 메시지가 그대로 담기고, 결과가 비면 `hint` 가 어디를 봐야 하는지 알려준다.

`parsed` 로 **모델이 발화를 어떻게 알아들었는지** 확인할 수 있고, `timings.parseMs` 가 카카오 5초 예산에서 실제로 깎이는 시간이다.

결과가 비면 `parse` 블록이 **"도시를 못 알아들었다"와 "타임아웃이라 물어보지도 못했다"를 구분해준다.** 둘은 완전히 다른 문제다.

```json
"parse": { "source": "model", "model": "gpt-5-nano", "timeoutMs": 4000,
           "timedOut": true, "error": "openai timeout after 4000ms" }
```

파싱 모델(`OPENAI_PARSE_MODEL`)은 검색 모델과 분리돼 있다. 검색은 품질이 중요하고 콜백 예산(1분)을 쓰지만, **파싱은 5초 예산 안에서 도는 유일한 모델 호출이라 속도가 곧 품질이다.** 느리면 도시를 못 알아들은 것과 똑같이 보인다.

| 옵션              | 용도                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `trace=true`       | 소요 시간·개수·설정·실패 원인을 `debug` 키로 같이 받는다                    |
| `affiliate=false`  | 애드픽 변환을 건너뛴다 (**기본은 켜짐**)                                     |
| `candidates=true`  | 1차 웹 검색 원문을 그대로 본다 — 모델이 뭘 긁어왔는지 (`trace=true` 필요)   |

> `affiliate` 를 켜든 끄든 **카드 JSON 은 같다.** 줄 링크는 어차피 `/r/{clickId}` 이고, 애드픽 주소는 그 302 목적지로만 쓰인다. 끄면 그 목적지가 원본 주소가 되므로, **커미션 링크가 제대로 나가는지 보려면 켜둔 채로 확인해야 한다** — `counts.affiliateFallback` 이 0 이어야 정상이다.

> ⚠️ 호출 한 번이 곧 OpenAI 요금이다. `/docs` 가 공개돼 있으므로 **운영에서는 `DEBUG_TOKEN` 을 반드시 채운다.** 비워두면 `APP_ENV=production` 에서 404 로 닫힌다.
>
> 한글 도시명은 URL 인코딩이 필요하다 (`--data-urlencode`). 스웨거에서는 자동으로 된다.

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
| 발화 캐시              | 같은 문장은 두 번 파싱하지 않는다 (`NLU_ALIAS_TTL_MINUTES`)                     |
| 검색 결과 캐시         | 같은 도시를 100명이 물어도 OpenAI 호출은 1회 (`SEARCH_CACHE_TTL_MINUTES`)       |
| 메모리 캐시 단         | DB 가 죽어도 캐시는 산다. 캐시가 죽으면 요청 하나가 곧 요금이다                 |
| in-flight 병합         | 같은 도시 동시 요청을 검색 1회로 묶는다                                         |
| 호스트 허용 목록       | 모델이 지어낸 예약 URL 을 버린다 — 트립닷컴·마이리얼트립·클룩·호텔스닷컴만 통과 |
| 썸네일 수집·검증       | 예약 페이지에서 대표 이미지를 긁고, 살아 있는 주소만 카드에 넣는다              |
| 두 호출 다 구조화 출력 | 모델이 결과 대신 "진행할까요?" 라고 되묻을 자리를 없앤다                        |

---

## 엔드포인트

| 메서드 | 경로                             | 용도                                                                |
| ------ | -------------------------------- | ------------------------------------------------------------------- |
| POST   | `/api/v1/kakao/hotels/recommend` | 오픈빌더 [호텔추천] 블록 스킬 → `listCard`                          |
| POST   | `/api/v1/kakao/flights/search`   | 오픈빌더 [항공권검색] 블록 스킬 → `itemCard` 캐러셀                 |
| POST   | `/api/v1/kakao/attractions/recommend` | 오픈빌더 [관광지추천] 블록 스킬 → `listCard` (구글맵 링크)     |
| POST   | `/api/v1/kakao/fallback`         | 폴백 블록 (호텔·항공권·관광지 안내)                                 |
| GET    | `/r/{clickId}`                   | **클릭 카운트 → 애드픽 302 리다이렉트** (DB 왕복 1회)               |
| GET    | `/health`                        | 앱 생존 (DB 안 건드림)                                              |
| GET    | `/health/db`                     | Supabase 실제 연결 진단                                             |
| GET    | `/api/v1/debug/hotel-search`     | **진단용 동기 검색** — 사용자가 보는 말풍선 그대로 (`DEBUG_TOKEN`)  |
| GET    | `/api/v1/debug/flight-search`    | 같은 것의 항공권판 (`DEBUG_TOKEN`)                                  |
| GET    | `/api/v1/debug/attraction-search`| 같은 것의 관광지판 (`DEBUG_TOKEN`)                                  |
| GET    | `/docs`                          | Swagger (운영에서도 켜져 있다)                                      |

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
        "label": "다른 도시 보기",
        "action": "message",
        "messageText": "호텔 추천해줘"
      }
    ]
  }
}
```

**각 줄의 `link.web` 이 호텔마다 다른 `clickId`** 를 가리킨다. 줄 전체가 클릭 영역이라 별도 버튼 없이도 어떤 호텔을 골랐는지 추적된다.

카카오 제약은 [`templates.ts`](src/modules/kakao/templates.ts) 에서 처리한다 — items **최대 5개**, 버튼 최대 2개, 라벨 14자. 그래서 서비스는 **애드픽 API 를 호출하기 전에** 호텔을 5개로 자른다.

### 항공권은 `itemCard` 캐러셀

> 전체 흐름·프롬프트·실패 진단은 **[docs/FLIGHT.md](docs/FLIGHT.md)** 에 따로 정리했다.

항공권은 listCard 에 담을 수 없다. **한 줄이 40자**인데 항공권 1건을 고르려면 항공사·편명·출발/도착 시각·소요·경유·가격이 다 필요하다. 그래서 key-value 줄을 세로로 쌓을 수 있는 [itemCard](https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format) 를 캐러셀로 보낸다.

캐러셀에는 listCard 의 `header` 같은 자리가 없다. 노선·조건·가격 주의 같은 **공통 맥락은 앞에 `simpleText` 하나를 세워** 전달한다 (카카오는 outputs 를 3개까지 받는다).

```json
{
  "outputs": [
    { "simpleText": { "text": "서울→오사카 왕복 항공권 5편이에요 ✈️\n…\n가격은 검색 시점 기준이라 실제 예약가와 다를 수 있어요." } },
    {
      "carousel": {
        "type": "itemCard",
        "items": [
          {
            "head": { "title": "서울 → 오사카 · 10/3(토)" },
            "itemList": [
              { "title": "항공사", "description": "대한항공 KE723" },
              { "title": "가는편", "description": "10/3(토) 09:20→11:00" },
              { "title": "오는편", "description": "10/6(화) 12:30→14:20" },
              { "title": "소요", "description": "1시간 40분 · 직항" }
            ],
            "itemListAlignment": "right",
            "itemListSummary": { "title": "예상가", "description": "1인 289,000원" },
            "buttons": [
              { "action": "webLink", "label": "예약 페이지 보기", "webLinkUrl": "https://…/r/Ab3xY9kQ2mZp" }
            ]
          }
        ]
      }
    }
  ]
}
```

itemCard 제한이 listCard 보다 빡빡하다 — **itemList 5줄, key 6자, value 1줄(20자), 캐러셀 10장.** 넘기면 잘려서 보이는 게 아니라 **말풍선이 통째로 렌더링되지 않는다.** 그래서 `templates.ts` 가 잘라 넣고, 값이 빈 줄은 아예 만들지 않는다. 왕복이면 4줄이 차므로 새 줄을 넣기 전에 무엇을 뺄지 먼저 정해야 한다.

`itemListAlignment: "right"` 는 취향이 아니다. 시각과 금액이 세로로 정렬돼야 카드를 넘기며 비교할 수 있다.

**호텔과 다른 점 세 가지**

| | 호텔 | 항공권 |
| --- | --- | --- |
| 카드 | `listCard` 한 장 (5줄) | `simpleText` + `itemCard` 캐러셀 |
| 캐시 TTL | `SEARCH_CACHE_TTL_MINUTES` (60분) | `FLIGHT_CACHE_TTL_MINUTES` (30분) — 운임이 빨리 상한다 |
| 항목의 신원 | `source_url` (호텔 1곳 = 주소 1개) | 편명 + 출발시각 — **여러 편이 같은 노선 검색 페이지를 공유한다** |

마지막 줄이 중요하다. 호텔처럼 주소로 중복을 지우면 **카드가 한 장만 남는다.**

### ⚠️ 항공권 가격은 확정 운임이 아니다

실시간 운임 API 가 없다. 웹 검색으로 얻는 건 "그 노선이 대략 얼마인가"이지 지금 살 수 있는 가격이 아니다. 그래서

- 카드 요약 줄은 `예상가` 로 적는다 (`최저가` 가 아니다)
- 안내 말풍선에 "가격은 검색 시점 기준이라 실제 예약가와 다를 수 있어요" 가 **항상** 들어간다
- 실제 금액은 예약 페이지에서 확정된다

`/api/v1/debug/flight-search?trace=true` 의 `counts.searchCalls` 가 0 이면 모델이 웹 검색을 안 하고 기억으로 답한 것이라 그 가격은 더더욱 믿을 수 없다.

GDS·항공사 API 가 붙으면 `FLIGHT_PROVIDER` 만 갈아끼우면 된다 — 서비스와 카드 조립 코드는 그대로다.

### ⚠️ 출발지를 말하지 않으면 서울 출발로 본다

"오사카 항공권" 처럼 출발지를 빼고 말하는 게 보통이다. 되묻는 대신 `FLIGHT_DEFAULT_ORIGIN_*`(기본 서울/ICN)에서 출발한다고 보고, **안내 말풍선에 "서울 출발 기준이에요" 를 적는다.** 부산에서 출발하려던 사람이 그 한 줄을 보고 고쳐 말할 수 있어야 한다 — 조용히 추측하면 잘못된 노선의 가격을 믿게 된다.

`FlightNluService` 는 이 추측을 하지 않는다. 출발지가 없으면 `null` 을 주고, 채우는 건 `FlightService.queryOf()` 다 (`originAssumed` 플래그가 그 사실을 카드까지 들고 간다).


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
  [다른 도시 보기]
```

발화 파서는 **호텔과 공유한다** (뽑을 게 도시 하나로 같다). 별칭 캐시도 공유되므로 "오사카 호텔" 을 물어본 사람이 "오사카 관광지" 를 물으면 파싱이 공짜다.

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
2. SQL Editor 에 [`0001_init.sql`](supabase/migrations/0001_init.sql) → [`0002_flight.sql`](supabase/migrations/0002_flight.sql) → [`0003_attraction.sql`](supabase/migrations/0003_attraction.sql) 순서로 붙여넣고 실행 (재실행 안전)
3. `.env` 에 `SUPABASE_URL` 과 `SUPABASE_SERVICE_ROLE_KEY` 입력 → [자세히](docs/DEPLOY.md)

시드 스크립트는 없다. **호텔·항공권·관광지 데이터는 전부 provider 가 런타임에 만든다.**

### 테이블 (6개 — 세 도메인 공용)

| 그룹      | 테이블                                                            |
| --------- | ----------------------------------------------------------------- |
| 캐시      | `search_cache` · `affiliate_links`                                |
| 행동 로그 | `users` · `messages` · `recommendations` · `recommendation_items` |

**전부 코드가 실제로 읽고 쓴다.** 빈 껍데기 테이블은 없다.

흐름: 발화 1건 → `messages` 1행 → `recommendations` 1행 → `recommendation_items` N행(노출) → 클릭 시 그 행의 `click_count` 증가

**호텔 마스터 테이블은 없다.** 매번 AI/크롤링으로 새로 받는 목록이라 이름으로는 같은 호텔을 못 묶는다. 호텔 신원은 `source_url` 이고 `affiliate_links` 가 그 역할을 한다. 집계는 **이름이 아니라 `source_url` 로** 한다.

**항공권·관광지도 같은 테이블을 쓴다.** `domain` 컬럼(`hotel` | `flight` | `attraction`)이 셋을 가른다 — 도메인마다 테이블을 복제하면 "이번 주 클릭 수" 같은 질문이 전부 union 이 되고, 클릭 추적 경로(`/r/{clickId}`)가 어느 테이블을 볼지부터 알아내야 한다. 컬럼 이름이 호텔 시절 그대로인 것들(`recommendation_items.hotel_name` 등)의 의미는 [`0002_flight.sql`](supabase/migrations/0002_flight.sql) 의 주석에 정리돼 있다.

ERD와 컬럼별 설명은 **[docs/DB.md](docs/DB.md)**.

---

## 카카오 오픈빌더 연결

1. **스킬** 3개 등록
   - 호텔: `https://bot.nolmoa.com/api/v1/kakao/hotels/recommend`
   - 항공권: `https://bot.nolmoa.com/api/v1/kakao/flights/search`
   - 관광지: `https://bot.nolmoa.com/api/v1/kakao/attractions/recommend`
2. **헤더** `X-Skill-Token` = `.env` 의 `KAKAO_SKILL_TOKEN` ← 빠뜨리면 401
3. **블록** 3개 생성
   - `호텔추천` — 예시 발화: `오사카 호텔 추천해줘`, `도쿄 숙소 알려줘`
   - `항공권검색` — 예시 발화: `오사카 항공권 찾아줘`, `다음달 3일 도쿄 왕복 2명`
   - `관광지추천` — 예시 발화: `오사카 관광지 추천해줘`, `도쿄 가볼만한 곳`
4. 폴백 블록 → `/api/v1/kakao/fallback`
5. **세 블록 모두 [콜백 사용] 을 켠다** ← 안 켜면 첫 검색이 사용자에게 안 간다 ([왜](#-오픈빌더에서-콜백을-켜야-한다))
6. 배포 (HTTPS 필수, **응답 5초 제한**)

### 도시는 어떻게 찾는가

세 블록 모두 같은 순서를 탄다. 위에서 걸리면 아래는 안 본다.

| 순서 | 수단 | 비용 | 무엇을 잡나 |
|---|---|---|---|
| 1 | 오픈빌더 엔티티 `여행도시` | 0ms · 0원 | 카카오가 이미 도시로 확정한 값 |
| 2 | 도시 사전 [`city-table.ts`](src/modules/nlu/city-table.ts) | 0ms · 0원 | 등록된 85개 도시 + 별칭(동경·Cebu·싱가폴) |
| 3 | 모델 (gpt-5-mini) | ~2초 · 유료 | 사전에 없는 도시, 오타, 긴 문장 |

**엔티티 이름은 한국어 그대로다.** 오픈빌더 커스텀 엔티티는 한국어 이름을 파라미터
키로 쓰므로 서버가 보는 것도 `여행도시` 다 (`city`·`sys_location` 등 영문 이름도
같이 보긴 한다). 영문 이름만 보던 동안에는 카카오가 정확히 뽑아준 도시를 통째로
버리고 매번 모델에 다시 물었고, 모델이 2.5초를 넘기면 "어느 도시…" 로 되물었다.

**엔티티를 안 만들어도 된다.** 사전과 모델이 폴백으로 남아 있다. 다만 엔티티를 쓰면
세 블록이 전부 모델 호출 없이 끝나므로 더 빠르고 싸다. 오픈빌더 엔티티에 도시를
추가하면 `city-table.ts` 에도 같이 추가해 양쪽을 맞춘다.

1·2 로 도시가 정해져도 **발화에 숫자·날짜 단서가 있으면** 모델을 한 번 더 부른다
("오사카 호텔 4명 2박", "다음달 3일 오사카 왕복"). 도시는 이미 정해졌으므로 모델이
도시를 바꿔 말해도 무시한다.

⚠️ **항공권은 날짜 엔티티가 와도 모델을 부른다.** `sys_date` 가 "다음달 3일" 을 절대 날짜로 주지 않을 때가 있고, 그러면 검색이 통째로 틀어진다. `YYYY-MM-DD` 형식만 엔티티 값으로 받아들인다.

⚠️ **항공권 출발지 엔티티는 없다.** 오픈빌더에서 발화의 출발지를 태깅하지 않았으므로 도시가 두 개 넘어오길 기대하면 안 된다. 출발지는 발화에서 파싱하고, 없으면 서울(ICN) 출발로 본다.

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
│   ├── kakao/                         스킬 엔드포인트
│   │   ├── kakao.controller.ts        호텔 추천 / 항공권 검색 / 관광지 추천 / 폴백
│   │   ├── templates.ts               listCard·itemCard·캐러셀 빌더 (길이·개수 제한)
│   │   └── dto/skill-payload.dto.ts   오픈빌더 요청 접근자
│   ├── hotel/                         유스케이스 전체 흐름
│   │   ├── hotel.service.ts           캐시 조회 / 콜백 / 백그라운드 검색
│   │   ├── hotel.types.ts             Hotel, HOTEL_PROVIDER 토큰
│   │   └── providers/openai.provider.ts   gpt-5-mini 2단 호출
│   ├── flight/                        항공권. 호텔과 같은 흐름, 카드만 다르다
│   │   ├── flight.service.ts          캐시 조회 / 콜백 / 백그라운드 검색
│   │   ├── flight.types.ts            Flight, 카드 문구, FLIGHT_PROVIDER 토큰
│   │   ├── flight-debug.controller.ts /api/v1/debug/flight-search
│   │   └── providers/openai.provider.ts   gpt-5-mini 2단 호출
│   ├── attraction/                    관광지. 예약이 없어 애드픽 단계가 통째로 빠진다
│   │   ├── attraction.service.ts      캐시 조회 / 콜백 / 백그라운드 검색
│   │   ├── attraction.types.ts        Attraction, 카드 문구, ATTRACTION_PROVIDER 토큰
│   │   ├── attraction-debug.controller.ts  /api/v1/debug/attraction-search
│   │   └── providers/openai.provider.ts    gpt-5-mini 2단 호출
│   ├── openai/openai.service.ts       Responses API 클라이언트
│   ├── nlu/                           발화 파싱 (모델 호출 + 별칭 캐시)
│   │   ├── nlu.service.ts             "오사카 4명" → { osaka, guests:4 } (호텔·관광지 공용)
│   │   ├── flight-nlu.service.ts      "내일 오사카 왕복 2명" → { ICN→KIX, 날짜, 2명 }
│   │   └── nlu.ts                     자료구조 + 퀵리플라이용 예시 도시
│   ├── adpick/adpick.service.ts       커미션 링크 생성 (키 마스킹·동시성 제한)
│   ├── affiliate/affiliate.service.ts 캐시 우선 링크 해석
│   ├── search-cache/                  검색 결과 캐시
│   ├── redirect/redirect.controller.ts  /r/{clickId}
│   ├── health/health.controller.ts    /health, /health/db
│   └── database/                      Supabase (@Global)
│       ├── supabase.service.ts        없으면 no-op
│       ├── memory-store.service.ts    no-op 모드 리다이렉트 폴백
│       └── repositories/              실패해도 예외를 올리지 않음
├── app.module.ts
└── main.ts
```

### 설계 규칙 3가지

- **DB 실패가 챗봇 응답을 죽이지 않는다.** repository 는 예외 대신 `null` 을 반환하고, 스킬 컨트롤러는 어떤 예외에도 200 + 안내 문구를 돌려준다. 카카오에 500을 주면 사용자에게는 원인 불명의 오류만 뜬다.
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

- [ ] 애드픽 API 키 발급 → `.env` 의 `ADPICK_API_KEY` (키만 넣으면 실제 커미션 링크로 전환)
- [ ] AI/크롤링 provider 구현 (결과 캐시는 이미 붙어 있음 — provider 만 교체하면 동작)
- [ ] 호텔 썸네일 실제 이미지로 교체 (현재 placeholder)
- [ ] 체크인/체크아웃 날짜 파싱 → [열린 이슈 4번](docs/PLAN.md)
- [x] 항공권 도메인 추가 (`recommendations.domain` 으로 구분)
- [ ] 항공권 실시간 운임 API(GDS·항공사) 연동 — 지금은 웹 검색 기반 **예상가**다. `FLIGHT_PROVIDER` 만 갈아끼우면 된다
- [x] 관광지 도메인 추가 (구글맵 링크, 제휴 없음)
- [x] 관광지 카드 이미지 — 위키백과 API (실측 87%. 나머지는 사진 없이 나간다)
- [ ] 관광지 사진별 저작권 표시 — 지금은 카드 단위 출처 버튼뿐 ([ATTRACTION.md](docs/ATTRACTION.md))

# travel-chatbot-app

카카오톡 여행 챗봇 스킬 서버. **NestJS + Supabase**.
현재 범위: **호텔 추천 (gpt-5-mini + 웹 검색)**

운영: https://bot.nolmoa.com · 기획: [docs/PLAN.md](docs/PLAN.md) · DB: [docs/DB.md](docs/DB.md) · 배포: [docs/DEPLOY.md](docs/DEPLOY.md)

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
# 스킬 호출 테스트
curl -s -X POST localhost:8000/api/v1/kakao/hotels/recommend \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"오사카 호텔 추천해줘","user":{"properties":{"botUserKey":"u1"}}}}' | jq
```

`SUPABASE_*` 를 비워두면 **no-op 모드**로 동작한다. DB 적재만 건너뛰고 카카오 응답과 리다이렉트는 정상이라, 오픈빌더 연동을 먼저 확인할 때 쓴다.

```bash
npm test           # 83개
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

스킬과 **똑같이 발화 하나만** 받아서 파싱부터 검색까지 다 돌린다.

```bash
curl -sG https://bot.nolmoa.com/api/v1/debug/hotel-search \
  -H "x-debug-token: $DEBUG_TOKEN" \
  --data-urlencode "utterance=오사카 여행갈건데 4명기준으로 숙소 추천해줘" | jq
```

```json
{
  "ok": true,
  "utterance": "오사카 여행갈건데 4명기준으로 숙소 추천해줘",
  "parsed": {
    "citySlug": "osaka",
    "cityName": "오사카",
    "guests": 4,
    "nights": null
  },
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

**여기서 진짜 걸리는 시간을 잰다.** 발화 파싱도 호텔 검색도 캐시를 타지 않고 매번 실제로 부르며, DB·캐시에는 아무것도 쓰지 않는다(진단 호출이 운영 캐시를 데워버리면 다음 측정이 거짓말이 된다). 실패하면 `ok: false` 와 에러 메시지가 그대로 담기고, 결과가 비면 `hint` 가 어디를 봐야 하는지 알려준다.

`parsed` 로 **모델이 발화를 어떻게 알아들었는지** 확인할 수 있고, `timings.parseMs` 가 카카오 5초 예산에서 실제로 깎이는 시간이다.

결과가 비면 `parse` 블록이 **"도시를 못 알아들었다"와 "타임아웃이라 물어보지도 못했다"를 구분해준다.** 둘은 완전히 다른 문제다.

```json
"parse": { "source": "model", "model": "gpt-5-nano", "timeoutMs": 4000,
           "timedOut": true, "error": "openai timeout after 4000ms" }
```

파싱 모델(`OPENAI_PARSE_MODEL`)은 검색 모델과 분리돼 있다. 검색은 품질이 중요하고 콜백 예산(1분)을 쓰지만, **파싱은 5초 예산 안에서 도는 유일한 모델 호출이라 속도가 곧 품질이다.** 느리면 도시를 못 알아들은 것과 똑같이 보인다.

| 옵션              | 용도                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `affiliate=true`  | 애드픽 변환까지 같이 재본다 (`affiliateStatus` 로 제휴사 지원 여부 확인) |
| `candidates=true` | 1차 웹 검색 원문을 그대로 본다 — 모델이 뭘 긁어왔는지                    |

> ⚠️ 호출 한 번이 곧 OpenAI 요금이다. `/docs` 가 공개돼 있으므로 **운영에서는 `DEBUG_TOKEN` 을 반드시 채운다.** 비워두면 `APP_ENV=production` 에서 404 로 닫힌다.
>
> 한글 도시명은 URL 인코딩이 필요하다 (`--data-urlencode`). 스웨거에서는 자동으로 된다.

### 비용과 안전장치

| 장치                   | 하는 일                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| 발화 캐시              | 같은 문장은 두 번 파싱하지 않는다 (`NLU_ALIAS_TTL_MINUTES`)                     |
| 검색 결과 캐시         | 같은 도시를 100명이 물어도 OpenAI 호출은 1회 (`SEARCH_CACHE_TTL_MINUTES`)       |
| 메모리 캐시 단         | DB 가 죽어도 캐시는 산다. 캐시가 죽으면 요청 하나가 곧 요금이다                 |
| in-flight 병합         | 같은 도시 동시 요청을 검색 1회로 묶는다                                         |
| 호스트 허용 목록       | 모델이 지어낸 예약 URL 을 버린다 — 트립닷컴·마이리얼트립·클룩·호텔스닷컴만 통과 |
| 썸네일 검증            | HEAD 로 살아 있는 이미지만 카드에 넣는다                                        |
| 두 호출 다 구조화 출력 | 모델이 결과 대신 "진행할까요?" 라고 되묻을 자리를 없앤다                        |

---

## 엔드포인트

| 메서드 | 경로                             | 용도                                                                |
| ------ | -------------------------------- | ------------------------------------------------------------------- |
| POST   | `/api/v1/kakao/hotels/recommend` | 오픈빌더 [호텔추천] 블록 스킬                                       |
| POST   | `/api/v1/kakao/fallback`         | 폴백 블록                                                           |
| GET    | `/r/{clickId}`                   | **클릭 카운트 → 애드픽 302 리다이렉트** (DB 왕복 1회)               |
| GET    | `/health`                        | 앱 생존 (DB 안 건드림)                                              |
| GET    | `/health/db`                     | Supabase 실제 연결 진단                                             |
| GET    | `/api/v1/debug/hotel-search`     | **진단용 동기 검색** — 실제 결과 + 단계별 소요 시간 (`DEBUG_TOKEN`) |
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
2. SQL Editor 에 [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) 붙여넣고 실행 (파일 하나, 재실행 안전)
3. `.env` 에 `SUPABASE_URL` 과 `SUPABASE_SERVICE_ROLE_KEY` 입력 → [자세히](docs/DEPLOY.md)

시드 스크립트는 없다. **호텔 데이터는 전부 provider 가 런타임에 만든다.**

### 테이블 (6개)

| 그룹      | 테이블                                                            |
| --------- | ----------------------------------------------------------------- |
| 캐시      | `search_cache` · `affiliate_links`                                |
| 행동 로그 | `users` · `messages` · `recommendations` · `recommendation_items` |

**전부 코드가 실제로 읽고 쓴다.** 빈 껍데기 테이블은 없다.

흐름: 발화 1건 → `messages` 1행 → `recommendations` 1행 → `recommendation_items` N행(노출) → 클릭 시 그 행의 `click_count` 증가

**호텔 마스터 테이블은 없다.** 매번 AI/크롤링으로 새로 받는 목록이라 이름으로는 같은 호텔을 못 묶는다. 호텔 신원은 `source_url` 이고 `affiliate_links` 가 그 역할을 한다. 집계는 **이름이 아니라 `source_url` 로** 한다.

ERD와 컬럼별 설명은 **[docs/DB.md](docs/DB.md)**.

---

## 카카오 오픈빌더 연결

1. **스킬** 등록 → URL `https://bot.nolmoa.com/api/v1/kakao/hotels/recommend`
2. **헤더** `X-Skill-Token` = `.env` 의 `KAKAO_SKILL_TOKEN` ← 빠뜨리면 401
3. **블록** `호텔추천` 생성, 예시 발화: `오사카 호텔 추천해줘`, `도쿄 숙소 알려줘`
4. 폴백 블록 → `/api/v1/kakao/fallback`
5. **`호텔추천` 블록의 [콜백 사용] 을 켠다** ← 안 켜면 첫 검색이 사용자에게 안 간다 ([왜](#-오픈빌더에서-콜백을-켜야-한다))
6. 배포 (HTTPS 필수, **응답 5초 제한**)

엔티티(`city`)를 안 만들어도 된다. 서버가 gpt-5-mini 로 발화를 직접 파싱하므로 자연어·오타를 그대로 받는다. 엔티티가 오면 모델을 부르지 않고 그 값을 쓴다(더 빠르고 공짜).

---

## 구조

```
src/
├── common/
│   └── guards/skill-token.guard.ts    X-Skill-Token (비우면 검증 안 함)
├── config/
│   ├── app.config.ts                  환경변수 → AppConfig
│   ├── database.config.ts             DB 활성 판단, 기대 테이블 목록
│   └── config.module.ts               전역 제공
├── modules/
│   ├── kakao/                         스킬 엔드포인트
│   │   ├── kakao.controller.ts        추천 / 폴백
│   │   ├── templates.ts               listCard 빌더 (길이·개수 제한)
│   │   └── dto/skill-payload.dto.ts   오픈빌더 요청 접근자
│   ├── hotel/                         유스케이스 전체 흐름
│   │   ├── hotel.service.ts           캐시 조회 / 콜백 / 백그라운드 검색
│   │   ├── hotel.types.ts             Hotel, HOTEL_PROVIDER 토큰
│   │   └── providers/openai.provider.ts   gpt-5-mini 2단 호출
│   ├── openai/openai.service.ts       Responses API 클라이언트
│   ├── nlu/                           발화 파싱 (모델 호출 + 별칭 캐시)
│   │   ├── nlu.service.ts             "오사카 4명" → { osaka, guests:4 }
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
- [ ] 항공권 도메인 추가 (`recommendations.domain` 으로 이미 구분됨)

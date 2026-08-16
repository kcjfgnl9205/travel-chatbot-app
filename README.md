# travel-chatbot-app

카카오톡 여행 챗봇 스킬 서버. **NestJS + Supabase**.
현재 범위: **호텔 추천 (Phase 1 — 고정 데이터)**

운영: https://bot.nolmoa.com · 기획: [docs/PLAN.md](docs/PLAN.md) · DB: [docs/DB.md](docs/DB.md) · 배포: [docs/DEPLOY.md](docs/DEPLOY.md)

> FastAPI 로 먼저 만들었다가 NestJS 로 전환했다. 전환 기록과 주의점은 [docs/MIGRATION.md](docs/MIGRATION.md).

---

## 빠른 실행

```bash
npm install
cp .env.example .env          # Supabase 없이도 그대로 뜬다
npm run start:dev             # http://localhost:8000
```

```bash
# 스킬 호출 테스트
curl -s -X POST localhost:8000/api/v1/kakao/hotels/recommend \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"오사카 호텔 추천해줘","user":{"properties":{"botUserKey":"u1"}}}}' | jq
```

`SUPABASE_*` 를 비워두면 **no-op 모드**로 동작한다. DB 적재만 건너뛰고 카카오 응답과 리다이렉트는 정상이라, 오픈빌더 연동을 먼저 확인할 때 쓴다.

```bash
npm test           # 39개
npx tsc --noEmit
```

---

## 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| POST | `/api/v1/kakao/hotels/recommend` | 오픈빌더 [호텔추천] 블록 스킬 |
| POST | `/api/v1/kakao/fallback` | 폴백 블록 |
| GET | `/r/{clickId}` | **클릭 카운트 → 애드픽 302 리다이렉트** (DB 왕복 1회) |
| GET | `/health` | 앱 생존 (DB 안 건드림) |
| GET | `/health/db` | Supabase 실제 연결 진단 |

### 링크는 이렇게 만들어진다

호텔 마스터를 소유하지 않는다. **AI/크롤링이 원본 호텔 주소를 찾아오고, 애드픽 API 가 그걸 커미션 링크로 바꾼다.**

```
AI/크롤링 → 원본 주소 (agoda.com/hotel/12345)
   ↓ GET biz.adpick.co.kr/api/{key}/link?url=...   (결과는 affiliate_links 에 캐시)
커미션 링크 (link.adpick.co.kr/xxxxxxxx)
   ↓ 카드 줄 링크는 이걸 직접 가리키지 않는다
/r/{clickId} → click_count + 1 → 302 → 커미션 링크
```

**리다이렉트를 한 홉 끼우는 이유**: 카카오 링크는 브라우저를 바로 열어 우리 서버로 아무 신호가 오지 않는다. 애드픽 링크를 카드에 직접 박으면 "사용자가 어떤 호텔을 골랐는지"를 영영 알 수 없다.

**캐시가 필요한 이유**: 애드픽 API 는 분당 60회 제한이고 180일 무클릭 링크를 삭제한다. 호텔 5건이면 요청 1건에 5회를 쓴다.

**추적은 2층 구조다.**

| | 범위 | 어디서 확인 |
|---|---|---|
| `p_data` = `h_{sha1(source_url)}` | 호텔 단위 (링크 생성 시 고정) | 애드픽 성과 데이터 API |
| `clickId` | 노출 1건 단위 | 우리 `recommendation_items.click_count` |

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
      { "label": "다른 도시 보기", "action": "message", "messageText": "호텔 추천해줘" }
    ]
  }
}
```

**각 줄의 `link.web` 이 호텔마다 다른 `clickId`** 를 가리킨다. 줄 전체가 클릭 영역이라 별도 버튼 없이도 어떤 호텔을 골랐는지 추적된다.

카카오 제약은 [`templates.ts`](src/modules/kakao/templates.ts) 에서 처리한다 — items **최대 5개**, 버튼 최대 2개, 라벨 14자. 그래서 서비스는 **애드픽 API 를 호출하기 전에** 호텔을 5개로 자른다.

---

## 시크릿 관리

`.env` 와 GitHub Secrets 는 **대체재가 아니라 용도가 다르다.**

| | 언제 읽히나 | 무엇을 넣나 |
|---|---|---|
| 로컬 `.env` (gitignore) | 내 PC 에서 개발할 때 | 개발용 값 |
| **서버 `.env`** (`chmod 600`) | **운영 컨테이너 실행 중** | 진짜 키 |
| GitHub Secrets | GitHub Actions 실행 중에만 | SSH 배포 키 |

**GitHub Secrets 는 런타임 저장소가 아니다.** 서버에서 도는 컨테이너는 읽지 못한다.

| 값 | 위험도 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **최상** — RLS 를 우회한다 |
| `ADPICK_API_KEY` | 높음 — 남이 쓰면 내 계정으로 링크가 생성됨 |
| `KAKAO_SKILL_TOKEN` | 중간 — 없으면 스킬 URL 을 아무나 호출 |

> 애드픽은 API 키가 **URL 경로**에 들어간다(`/api/{apikey}/link`). 예외 메시지에 요청 URL 이 담기므로, 그냥 로깅하면 키가 로그와 `affiliate_links.error` 에 남는다. [`adpick.service.ts`](src/modules/adpick/adpick.service.ts) 의 `redact()` 가 `***` 로 가린다.

---

## Supabase 셋업

1. 프로젝트 생성 — **리전 Seoul** 권장
2. SQL Editor 에 [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) 붙여넣고 실행 (파일 하나, 재실행 안전)
3. `.env` 에 `SUPABASE_URL` 과 `SUPABASE_SERVICE_ROLE_KEY` 입력 → [자세히](docs/DEPLOY.md)

시드 스크립트는 없다. **호텔 데이터는 전부 provider 가 런타임에 만든다.**

### 테이블 (6개)

| 그룹 | 테이블 |
|---|---|
| 캐시 | `search_cache` · `affiliate_links` |
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
5. 배포 (HTTPS 필수, **응답 5초 제한**)

엔티티(`city`)를 안 만들어도 서버가 발화 텍스트에서 도시를 폴백 파싱한다.

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
│   │   ├── hotel.service.ts
│   │   ├── hotel.types.ts
│   │   └── providers/static.provider.ts   ← ai/crawler 는 여기 추가
│   ├── nlu/nlu.ts                     도시·인원·박수 파싱
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

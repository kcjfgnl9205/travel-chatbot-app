# travel-chatbot-nest

파이썬(FastAPI)판을 **NestJS 로 포팅한 것**. 같은 저장소 안에 나란히 있다.

- 환경변수 이름이 **완전히 동일**하다 → 같은 `.env` 로 양쪽 다 돌아간다
- `data/hotels.json` 도 **같은 파일**을 읽는다 (repo 루트)
- DB 스키마는 그대로 (`supabase/migrations/0001_init.sql`)

응답 JSON 이 파이썬판과 **바이트 단위로 같은 것**을 대조 검증했다 (아래 참고).

---

## 실행

```bash
cd nest
npm install
npm run start:dev          # http://localhost:8000
```

`.env` 는 repo 루트의 것을 자동으로 읽는다 (`envFilePath: ['.env', '../.env']`).

```bash
curl -s localhost:8000/health
curl -s localhost:8000/health/db

curl -s -X POST localhost:8000/api/v1/kakao/hotels/recommend \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"오사카 호텔 추천해줘","user":{"properties":{"botUserKey":"u1"}}}}'
```

```bash
npm test                   # 39개
```

---

## 파이썬판과 같은지 확인하는 법

두 서버를 같은 환경변수로 띄우고 응답을 비교한다. `click_id` 만 정규화한다.

```bash
# 터미널 1 — 파이썬
SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY= PUBLIC_BASE_URL=http://cmp.test \
ADPICK_API_KEY= ADPICK_LINK_TEMPLATE='https://adpick.test/c/AB12?url={source_url}' \
.venv/bin/uvicorn app.main:app --port 18101

# 터미널 2 — Nest (같은 환경변수)
cd nest && PORT=18102 npx ts-node src/main.ts
```

발화 7종 + 폴백 2종을 양쪽에 던져 JSON 을 비교했고 전부 일치했다.

> 포팅 중 실제로 하나 어긋났다. **평점 9.0 을 JS 는 `9` 로 찍는다**(파이썬 float 은 `9.0`).
> `scoreText()` 가 소수점 한 자리를 유지해 문자열을 맞춘다. 안 그랬으면 전환하는 순간
> 사용자 화면의 평점 표기가 조용히 바뀌었을 것이다.

---

## 구조

```
src/
├── main.ts                        진입점
├── app.module.ts
├── config/configuration.ts        환경변수 (파이썬과 같은 이름)
├── kakao/
│   ├── skill-payload.ts           오픈빌더 요청 접근자
│   └── templates.ts               listCard 빌더 (길이·개수 제한 처리)
├── nlu/nlu.ts                     도시·인원·박수 파싱
├── hotel/
│   ├── hotel.types.ts             Hotel, 표시 문자열
│   ├── providers/static.provider.ts
│   └── hotel.service.ts           유스케이스 전체 흐름
├── adpick/adpick.service.ts       커미션 링크 생성 (키 마스킹·동시성 제한)
├── affiliate/affiliate.service.ts 캐시 우선 링크 해석
├── search-cache/                  검색 결과 캐시
├── db/
│   ├── supabase.service.ts        없으면 no-op
│   ├── memory-store.service.ts    no-op 모드 리다이렉트 폴백
│   └── repositories/              실패해도 예외를 올리지 않음
└── api/
    ├── kakao-hotel.controller.ts  추천 / 폴백
    ├── redirect.controller.ts     /r/{clickId}
    ├── health.controller.ts       /health, /health/db
    └── skill-token.guard.ts       X-Skill-Token (비우면 검증 안 함)
```

설계 규칙은 파이썬판과 동일하다 — 자세한 배경은 [../docs/PLAN.md](../docs/PLAN.md), [../docs/DB.md](../docs/DB.md).

- **DB 실패가 챗봇 응답을 죽이지 않는다.** repository 는 예외 대신 `null` 을 반환하고,
  스킬 컨트롤러는 어떤 예외에도 200 + 안내 문구를 돌려준다.
- **애드픽 변환이 실패해도 카드는 나간다.** 원본 주소로 폴백한다.
- **클릭은 카운터다.** `register_click()` RPC 하나로 조회·증가·목적지 반환을 처리한다.

---

## 서버로 교체하기

지금 서버는 파이썬판이 돌고 있다. 바꾸려면 repo 루트의 `docker-compose.yml` 에서
`app` 서비스의 빌드 대상만 Nest 쪽으로 바꾸면 된다.

```yaml
  app:
    build:
      context: .                  # data/ 를 담아야 하므로 컨텍스트는 repo 루트
      dockerfile: nest/Dockerfile
```

나머지(Caddy·`.env`·GitHub Actions·Supabase)는 손댈 게 없다.
되돌리려면 `build: .` 로만 바꾸면 파이썬판으로 즉시 복귀한다.

> ⚠️ CI(`.github/workflows/deploy.yml`)는 아직 파이썬 테스트만 돌린다.
> Nest 로 교체할 때 `npm test` 도 함께 돌도록 워크플로를 고쳐야 한다.

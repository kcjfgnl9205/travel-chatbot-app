# 작업 지시서 — 라우터 배포 후 남은 문제

> 2026-09-12 기준. **이 문서 하나만 읽고 이어서 작업할 수 있게** 쓴다.
> 구조 설명은 [ROUTER.md](ROUTER.md), 이 문서는 **지금 무엇이 깨져 있고 무엇을 해야 하는가**다.

---

## 0. 한 줄 요약

라우터 재설계는 배포됐고 DB·키도 정상인데, **검색이 카카오 콜백 예산(1분)을 못 지켜서
사용자에게 카드가 도착하지 않는다.** 단톡방에서는 "찾고 있어요" 만 반복된다.

---

## 1. 지금 상태 (직접 확인한 것)

```bash
curl -s https://bot.nolmoa.com/health
# {"status":"ok","env":"production","db":"supabase",
#  "providers":{"hotel":"openai","flight":"openai","attraction":"openai"},
#  "openai":"gpt-5-mini","adpick":"api"}

curl -s https://bot.nolmoa.com/health/db
# 9개 테이블 전부 true  ← 0004_router.sql 실행 완료
```

| 항목 | 상태 |
|---|---|
| 라우터 코드 | ✅ 배포됨 (`/api/v1/kakao/router` 401, 옛 `hotels/recommend` 404) |
| Supabase 0004 | ✅ 실행 완료 |
| OPENAI_API_KEY | ✅ 살아 있음, 모델 gpt-5-mini |
| 폴백 블록 [콜백 사용] | ❌ **꺼져 있다** (아래 2-③ 참고) |
| 검색 소요 시간 | ❌ 43~75초 — 콜백 1분 예산 초과 |
| 미머지 브랜치 | ⚠️ `fix/docker-build-env-example` — **머지해야 배포가 다시 돈다** |

---

## 2. 증상과 원인 (전부 측정으로 확인함)

**증상**: 단톡방에서 "오사카 호텔 추천해줘" → `오사카 호텔을 찾고 있어요 🔍 30초쯤 뒤에
다시 물어봐 주세요!` 만 반복. 카드가 영영 안 나온다.

### ① 모델이 웹 검색을 건너뛴다

```
hotel search city=후쿠오카 searches=0 candidates=0 chars=17 ms=5078
```

`searches=0` = web_search 를 한 번도 안 돌고 5초 만에 `{"candidates":[]}` 를 반환.
같은 질의가 어떤 때는 정상(20건), 어떤 때는 이렇다. **모델 변덕이다.**

빈손은 1분짜리 짧은 TTL 로만 굳히므로(한 번의 빈손을 10분씩 굳히지 않으려고 그렇게
해뒀다 — [search.service.ts](../src/modules/search/search.service.ts) `runSearch`),
1분 뒤 다시 물으면 또 "찾고 있어요" 가 나온다. **이 루프가 사용자가 본 것이다.**

→ **`tool_choice: 'required'` 로 검색을 강제했다** (작업 트리에 있음, 아래 3-A-1).

### ② 검색이 성공해도 느리다 — 1분 예산 초과

카카오 규칙: **5초 안에 대기 응답 + 1분 안에 콜백 POST.** 넘기면 그 카드는 버려진다.

실측 (gpt-5-mini, `tool_choice: required` 적용 후):

| 설정 | 결과 | 단계별 |
|---|---|---|
| limit=20 cand=30 (서버) | 64.8초 / 16건 | |
| limit=20 cand=30 (로컬) | 74.4초 / 20건 | |
| limit=20 cand=30 | **빈손** / 28.7초 | rank 가 20개를 못 만들고 실패 |
| limit=12 cand=20 | 43.4초 / 5건 | search 23.3초 + rank 24.5초 |
| limit=12 cand=20 | 54.9초 / 9건 | rank 30.1초 |
| limit=8 cand=16 | 47.3초 / 8건 | search 18.1초 + rank 23.3초 |
| limit=10 cand=20 **rank=minimal** | 27.5초 / **0건** | search 17.8초 + rank **9.7초** |
| limit=10 cand=20 **rank=minimal** (후쿠오카) | 27.1초 / **0건** | search 17.3초 + rank **9.7초** |

**핵심 1: 건수를 줄여도 크게 안 준다.** 두 번의 모델 호출 왕복이 고정비다
(1차 웹 검색 17~23초, 2차 선별 23~30초). 20건 요청은 실패율도 올린다
(rank 가 20개 출력을 못 만들고 빈손으로 끝났다).

**핵심 2: `OPENAI_RANK_EFFORT=minimal` 은 2차 호출을 30초 → 9.7초로 줄이지만
결과가 0건이 된다.** rank 는 `picks=10` 을 돌려주는데 그중 `source_url` 이 비어
있거나 "정보 없음" 이라 전부 버려진다(스키마상 필수 필드인데도 그렇다).
**즉 지금 그대로는 못 쓴다.** 프롬프트/스키마를 손보면 살릴 수 있는지가 관건이고,
살리면 **총 27초**로 콜백 예산 안에 넉넉히 들어간다 — 가장 가치 있는 실험이다.

### ③ 폴백 블록의 [콜백 사용] 이 꺼져 있다

사용자가 받은 문구 `30초쯤 뒤에 다시 물어봐 주세요!` 는 **콜백이 없을 때만** 나가는
경로다([cards.ts](../src/modules/kakao/cards.ts) `searchStartedText`). 켜져 있으면
`오사카 호텔을 찾고 있어요. 잠시만요 🔍` (callbackAck) 가 나간다.

카카오는 그 블록에서 콜백을 켰을 때만 `userRequest.callbackUrl` 을 실어 보낸다.
**코드로 못 켠다. 오픈빌더에서 직접 켜야 한다.**

---

## 3. 해야 할 일

### A. 코드 (우선순위 순)

#### A-1. `tool_choice: 'required'` 커밋 ⏳ 작업 트리에 있음

[openai.service.ts](../src/modules/openai/openai.service.ts) 에 `toolChoice` 를 추가하고
세 provider 의 1차 호출에 `toolChoice: 'required'` 를 걸어뒀다. **테스트·커밋만 남았다.**

- `npx tsc --noEmit && npx jest` 통과 확인
- 가짜 provider 를 쓰는 테스트라 이 변경은 단위 테스트로 잡히지 않는다 —
  `/api/v1/debug/search` 로 실제 호출 1회 확인할 것

#### A-2. **검색을 1분 안에 끝낸다** ← 이게 본체다

목표: **총 45초 이하** (1분 예산에 여유를 두고). 후보 수단을 효과 큰 순서로:

| 수단 | 실측 | 대가 |
|---|---|---|
| ① **`rank=minimal` 을 쓸 수 있게 만든다** | **30초 → 9.7초** (총 27초) | 지금은 `source_url` 이 비어 와 0건. **이걸 고치는 게 1순위** |
| ② `RESULT_MAX_ITEMS` 20 → 10 | 몇 초 + **실패율 감소** | 더보기 2페이지까지 |
| ③ 썸네일을 첫 페이지(5건)만 수집 | 미측정 | 2페이지 사진 없음 |
| ④ **rank 호출 제거** (1차 결과를 서버가 정렬) | 23~30초 절감 (총 ~20초) | 모델의 비교·선별이 사라진다. 최후 수단 |

**①이 가장 값싸고 효과가 크다.** rank 가 minimal 에서 `source_url` 을 빼먹는 것만
해결하면 총 27초로 예산 안에 들어간다. 시도해볼 것:

- 2차 프롬프트에 "후보 목록의 `source_url` 을 **그대로 복사**하라. 새로 만들지 마라" 를 명시
- 후보 JSON 에 번호를 붙이고 rank 는 **번호만** 고르게 한다(URL 을 다시 쓰게 하지 않는다) ← 가장 확실하다.
  출력이 짧아져서 더 빨라지고, 지어낸 URL 이 원천적으로 불가능해진다
- 그래도 안 되면 ②③을 더하고, 마지막에 ④

⚠️ **측정 없이 고르지 마라.** 아래 벤치로 재고, **도시를 바꿔가며** 2회 이상 돌린다.

벤치 방법 (로컬):

```bash
set -a; source .env; set +a
export SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY= DEBUG_TOKEN=dbg PORT=8231
export OPENAI_MODEL=gpt-5-mini RESULT_MAX_ITEMS=10 OPENAI_CANDIDATE_COUNT=20 OPENAI_RANK_EFFORT=minimal
npm run build && node dist/main.js > /tmp/bench.log 2>&1 &
curl -s -m 200 -X POST localhost:8231/api/v1/debug/search \
  -H 'content-type: application/json' -H 'x-debug-token: dbg' \
  -d '{"utterance":"오사카 호텔 추천해줘"}' | jq '{itemCount, timing}'
grep -E "hotel (search|rank) city" /tmp/bench.log   # 단계별 ms
```

⚠️ 한 번 돌 때마다 OpenAI 요금이 나간다. 같은 도시를 반복하면 모델 캐시 효과로
빨라 보일 수 있으니 **도시를 바꿔가며** 잰다.

#### A-3. 콜백 예산을 넘기면 헛되이 쏘지 않는다

[search.service.ts](../src/modules/search/search.service.ts) `runSearch` → `push()`.
검색 시작부터 1분이 지났으면 카카오가 콜백을 거부하므로, **푸시 대신 저장만 하고**
로그에 남긴다("콜백 예산(1분) 초과 — 다음 질문에 카드가 나간다"). 지금은 헛되이
POST 하고 rejected 로그만 남는다.

#### A-4. 진단에 provider trace 를 되살린다 (선택)

이번 원인 규명이 **서버 로그 없이는 불가능**했다. `searches=0` 은 로그에만 있다.
`/api/v1/debug/search` 응답에 `searchCalls` · `candidates` · `picks` · 단계별 ms 를
같이 실어주면 다음 사람이 로그를 못 봐도 원인을 짚는다.
(예전 `*-debug.controller.ts` 에 있던 `trace=true` 를 라우터 구조에 맞게 되살리는 것)

### B. 사람이 해야 할 일 (코드로 못 하는 것)

| # | 무엇 | 어디서 |
|---|---|---|
| B-1 | **폴백 블록 [콜백 사용] 켜기** | 오픈빌더 → 폴백 블록 |
| B-2 | `fix/docker-build-env-example` PR 머지 | GitHub (안 하면 배포가 계속 실패) |
| B-3 | 서버 `.env` 에 `RESULT_MAX_ITEMS` 등 확정값 반영 후 `docker compose up -d --force-recreate app` | 오라클 VM |
| B-4 | 대화에 노출된 키 5개 재발급 | Supabase · OpenAI · 애드픽 · 카카오 |

⚠️ **서버 `.env` 는 배포가 건드리지 않는다.** `git reset --hard` 는 추적 파일만 되돌리고
`.env` 는 gitignore 다 — 코드 기본값을 올려도 서버에 옛 값이 있으면 그게 이긴다.

---

## 4. 하지 말 것 (이미 당한 것들)

- **빈 결과를 한 번에 오래 굳히지 마라.** 모델은 같은 질의에도 가끔 빈손이다. 한 번에
  10분을 굳혔더니 "도쿄 호텔" 이 10분짜리 장애가 됐다. 지금은 연속 2회일 때만 굳힌다.
- **itemCard·캐러셀로 되돌리지 마라.** 그룹챗봇이 못 그린다 — 말풍선이 통째로 사라진다.
- **읽지 않는 환경변수를 남기지 마라.** `HOTEL_PROVIDER=static` 이 운영 .env 에 있었고
  주석에는 "비용 절감" 이라고 적혀 있었다. 아무 일도 안 하면서 OpenAI 요금은 그대로
  나갔다. [env-example.spec.ts](../test/env-example.spec.ts) 가 이제 막는다.
- **`.env.example` 을 지우거나 Dockerfile 에서 빼지 마라.** 테스트가 읽는다. 빠지면
  로컬 `npm test` 는 통과하는데 도커 빌드만 깨진다(실제로 배포가 한 번 막혔다).
- **실값 `.env` 를 이미지에 넣지 마라.** 시크릿은 런타임 `env_file` 로만.
- **결과가 비었을 때 "도시 이름을 확인하세요" 라고 하지 마라.** 지역은 제대로 알아들은
  경우가 대부분이라 사용자가 자기 잘못인 줄 알고 헤맨다.

---

## 5. 확인 명령 모음

```bash
# 어느 버전이 떠 있나 / 키·모델은 뭔가
curl -s https://bot.nolmoa.com/health | jq

# 마이그레이션 상태 (없으면 어느 파일을 실행할지 알려준다)
curl -s https://bot.nolmoa.com/health/db | jq

# 발화 해석만 (싸다) — "왜 도움말이 나오지?" 를 가릴 때
curl -s -X POST https://bot.nolmoa.com/api/v1/debug/parse \
  -H 'content-type: application/json' -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"utterance":"오사카 호텔 추천해줘"}' | jq

# 전체 파이프라인 동기 실행 — 사용자가 볼 말풍선 그대로 (OpenAI 요금 발생)
curl -s -m 200 -X POST https://bot.nolmoa.com/api/v1/debug/search \
  -H 'content-type: application/json' -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"utterance":"오사카 호텔 추천해줘"}' | jq '{itemCount, timing, response}'

# 서버 로그에서 원인 (searches=0 이면 모델이 검색을 건너뛴 것)
docker compose logs app --tail=200 | grep -E "hotel search|rank|WARN|ERROR"
```

---

## 6. 파일 지도 (이번 작업에서 손댈 곳)

| 파일 | 왜 |
|---|---|
| [openai/openai.service.ts](../src/modules/openai/openai.service.ts) | `tool_choice`, 타임아웃, 재시도 |
| [hotel/providers/openai.provider.ts](../src/modules/hotel/providers/openai.provider.ts) | 2단 호출·썸네일. 항공권·관광지도 같은 모양 |
| [search/search.service.ts](../src/modules/search/search.service.ts) | 선점·백그라운드 검색·콜백 푸시 |
| [config/app.config.ts](../src/config/app.config.ts) | 기본값(RESULT_MAX_ITEMS·EFFORT) |
| [.env.example](../.env.example) | knob 을 바꾸면 **여기도 같이** (테스트가 막는다) |
| [debug/debug.controller.ts](../src/modules/debug/debug.controller.ts) | A-4 trace 되살리기 |

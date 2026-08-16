# FastAPI → NestJS 전환 기록

이 저장소는 **FastAPI(Python)로 먼저 만들어졌다가 NestJS 로 전환**했다.
파이썬 코드는 전부 삭제됐고 `git log` 에만 남아 있다.

이 문서는 **왜 그렇게 됐는지**와 **전환하면서 실제로 걸린 것**을 남긴다.
새로 합류하거나 세션을 새로 시작할 때 여기부터 보면 된다.

---

## 무엇이 바뀌지 않았는가

전환 비용을 낮추려고 세 가지를 그대로 뒀다. **지금도 유효하다.**

| | |
|---|---|
| 환경변수 이름 | `SUPABASE_URL`, `ADPICK_API_KEY`, `ADPICK_TIMEOUT_SECONDS` … 전부 동일 |
| `data/hotels.json` | 같은 파일, 같은 스키마 |
| DB 스키마 | `supabase/migrations/0001_init.sql` 그대로. 마이그레이션 재실행 불필요 |
| 엔드포인트 경로 | `/api/v1/kakao/hotels/recommend`, `/r/{clickId}`, `/health`, `/health/db` |
| 응답 JSON | **바이트 단위로 동일** (아래 참고) |

즉 **카카오 오픈빌더 설정도, Supabase 도, 서버의 `.env` 도 손댈 게 없었다.**

---

## 응답 동일성을 어떻게 확인했는가

두 서버를 같은 환경변수로 띄우고 발화 7종 + 폴백 2종의 응답 JSON 을 비교했다.
`clickId` 는 매번 달라지므로 `/r/<CLICK_ID>` 로 정규화한 뒤 문자열 비교.

```
일치   "오사카 호텔 추천해줘"      일치   "파리 호텔 추천해줘"
일치   "도쿄 숙소 알려줘"          일치   "호텔 추천해줘" (city=후쿠오카)
일치   "후쿠오카 호텔"             일치   "오사카 2박 3명 호텔"
일치   "호텔 추천해줘"             일치   [폴백] ×2
```

리다이렉트(302 목적지, 없는 ID → 404)도 동일.

### 이 대조에서 실제로 하나 걸렸다

**JS 는 `9.0` 을 `9` 로 찍는다.** 파이썬 float 은 `9.0` 이다.

```
파이썬:  1박 195,000원~ · 평점 9.0 · 우에노
JS(초기): 1박 195,000원~ · 평점 9 · 우에노
```

그냥 뒀으면 전환하는 순간 **사용자 화면의 평점 표기가 조용히 바뀌었을 것이다.**
[`hotel.types.ts`](../src/modules/hotel/hotel.types.ts) 의 `scoreText()` 가 소수점 한 자리를 유지한다.

> 교훈: 언어를 바꿀 때 로직보다 **숫자·날짜 포맷팅**이 먼저 어긋난다.
> 응답 전체를 문자열로 비교하지 않았으면 못 잡았을 차이다.

---

## 구조가 어떻게 대응되는가

| FastAPI | NestJS |
|---|---|
| `app/core/config.py` | `src/config/app.config.ts` + `database.config.ts` |
| `app/kakao/templates.py` | `src/modules/kakao/templates.ts` |
| `app/kakao/schemas.py` | `src/modules/kakao/dto/skill-payload.dto.ts` |
| `app/services/nlu.py` | `src/modules/nlu/nlu.ts` |
| `app/services/adpick.py` | `src/modules/adpick/adpick.service.ts` |
| `app/services/affiliate.py` | `src/modules/affiliate/affiliate.service.ts` |
| `app/services/search_cache.py` | `src/modules/search-cache/search-cache.service.ts` |
| `app/domain/hotel/service.py` | `src/modules/hotel/hotel.service.ts` |
| `app/db/repositories/*` | `src/modules/database/repositories/*` |
| `app/api/v1/*` | `src/modules/{kakao,redirect,health}/*.controller.ts` |
| `app/api/deps.py` (토큰 검증) | `src/common/guards/skill-token.guard.ts` |

### 구현 방식이 달라진 곳

**1. Supabase 클라이언트 캐싱**

파이썬판은 이벤트 루프에 묶여서, TestClient 로 두 번 호출하면
`Event loop is closed` 가 났다(루프가 바뀌면 재생성하도록 고쳤었다).
Node 클라이언트는 그런 제약이 없어서 단순한 싱글턴으로 끝난다.

**2. 동시 호출 제한**

파이썬은 `asyncio.Semaphore`, Nest 는 직접 만든 대기 큐(`acquire`/`release`).
목적은 같다 — 애드픽 rate limit(분당 60회) 대비 버스트 억제.

**3. `secrets.token_urlsafe(9)` → `randomBytes(9).toString('base64url')`**

둘 다 12자 URL-safe 문자열. 길이와 문자셋이 같아야 기존 `click_id` 와 섞여도 문제없다.

---

## 전환할 때 같이 바꿔야 했던 것

코드만 바꾸면 안 되는 것들이다. **다음에 또 언어를 바꾼다면 이 목록을 확인할 것.**

- `Dockerfile` — 멀티스테이지(빌드 → prune → 실행), `CMD ["node","dist/main"]`
- `.github/workflows/deploy.yml` — `pytest` → `npm ci && npx tsc --noEmit && npm test`
  (이걸 안 바꾸면 **Nest 코드가 깨져도 배포가 통과한다**)
- `deploy/remote.sh` — 헬스체크가 `python -c` 로 되어 있었다 → `node -e`
- `.gitignore` — `.venv/`, `__pycache__/` → `node_modules/`, `dist/`

`docker-compose.yml`, `Caddyfile`, Supabase, 카카오 설정은 **손대지 않았다.**

---

## 지금 상태

```
테이블 6개   users · messages · recommendations · recommendation_items
             · affiliate_links · search_cache
테스트       39개 (npm test)
운영         https://bot.nolmoa.com — Caddy(TLS 자동) → Nest
배포         main push → 테스트 → SSH → 재빌드
```

미완인 것은 [PLAN.md 의 열린 이슈](PLAN.md)와 [README 의 다음 단계](../README.md)에 있다.
가장 큰 건 **애드픽 실키 연결**과 **AI/크롤링 provider** 두 개다.

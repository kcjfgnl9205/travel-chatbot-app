# travel-chatbot-app

카카오톡 여행 챗봇 스킬 서버. **FastAPI + Supabase**.
현재 범위: **호텔 추천 (Phase 1 — 고정 데이터)**

기획 문서는 [docs/PLAN.md](docs/PLAN.md).

---

## 빠른 실행

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env          # Supabase 없이도 그대로 뜬다

uvicorn app.main:app --reload
```

```bash
# 스킬 호출 테스트
curl -s -X POST localhost:8000/api/v1/kakao/hotels/recommend \
  -H 'content-type: application/json' \
  -d '{"userRequest":{"utterance":"오사카 호텔 추천해줘","user":{"properties":{"botUserKey":"u1"}}},"action":{"params":{}}}' | jq
```

`SUPABASE_*` 를 비워두면 **no-op 모드**로 동작한다. DB 적재만 건너뛰고 카카오 응답과 리다이렉트는 정상이라, 오픈빌더 연동을 먼저 확인할 때 쓴다.

```bash
pytest        # 18개
ruff check .
```

---

## 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| POST | `/api/v1/kakao/hotels/recommend` | 오픈빌더 [호텔추천] 블록 스킬 |
| POST | `/api/v1/kakao/fallback` | 폴백 블록 |
| GET | `/r/{click_id}` | **클릭 추적 → 애드픽 302 리다이렉트** |
| GET | `/health` | 헬스체크 |
| GET | `/docs` | Swagger |

### `/r/{click_id}` 가 왜 필요한가

카카오 `webLink` 버튼은 브라우저를 바로 열기 때문에 **우리 서버로 아무 신호가 오지 않는다.**
애드픽 링크를 카드에 직접 박으면 "사용자가 어떤 호텔을 골랐는지"를 영영 알 수 없다.

```
카드 버튼 → /r/{click_id} → clicks INSERT → 302 → 애드픽 딥링크
```

`click_id` 는 추천을 응답하는 시점에 호텔마다 하나씩 발급되어 `recommendation_items` 에 저장된다.
`ADPICK_SUBID_PARAM` 을 설정하면 애드픽 링크에 `?subid={click_id}` 로 실려 나가므로,
나중에 애드픽 전환 리포트와 우리 DB를 **정확히 1:1 매칭**할 수 있다.

---

## Supabase 셋업

1. Supabase 프로젝트 생성
2. SQL Editor 에 [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) 붙여넣고 실행
3. `.env` 에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Settings → API → **service_role**) 입력
4. 호텔 시드 적재:
   ```bash
   python -m scripts.seed_hotels
   ```

> service_role 키는 RLS를 우회한다. **절대 클라이언트에 노출 금지**, 서버 환경변수로만.

### 테이블

`users` · `messages` · `cities` · `hotels` · `hotel_offers` · `recommendations` · `recommendation_items` · `clicks` · `conversions`

흐름: 발화 1건 → `messages` 1행 → `recommendations` 1행 → `recommendation_items` N행 → 클릭 시 `clicks` 1행

ERD와 컬럼별 설명은 **[docs/DB.md](docs/DB.md)**.

---

## 카카오 오픈빌더 연결

1. **스킬** 등록 → URL `https://{도메인}/api/v1/kakao/hotels/recommend`
2. **블록** `호텔추천` 생성, 예시 발화: `오사카 호텔 추천해줘`, `도쿄 숙소 알려줘`
3. 스킬 연결 후 배포 (HTTPS 필수, **응답 5초 제한**)
4. (선택) 스킬 헤더에 `X-Skill-Token` 을 넣고 `.env` 의 `KAKAO_SKILL_TOKEN` 에 같은 값 설정 → 외부 호출 차단

엔티티(`city`)를 안 만들어도 서버가 발화 텍스트에서 도시를 폴백 파싱하므로 그대로 동작한다.

---

## 구조

```
app/
├── main.py                     FastAPI 엔트리
├── core/config.py              환경변수
├── api/v1/
│   ├── kakao_hotel.py          스킬 엔드포인트 (얇음)
│   └── redirect.py             /r/{click_id}
├── kakao/
│   ├── schemas.py              오픈빌더 요청 모델
│   └── templates.py            카드/캐러셀/퀵리플라이 빌더 (길이 제한 처리)
├── domain/hotel/
│   ├── service.py              유스케이스 전체 흐름
│   └── providers/              static ← 지금 / ai · crawler ← Phase 3
├── services/
│   ├── nlu.py                  도시·인원·박수 파싱
│   └── adpick.py               제휴 링크 빌더
└── db/
    ├── supabase_client.py      없으면 no-op
    ├── memory_store.py         no-op 모드용 리다이렉트 폴백
    └── repositories/           실패해도 예외를 올리지 않음
```

### 설계 규칙 2가지

- **DB 실패가 챗봇 응답을 죽이지 않는다.** repository 는 예외 대신 `None` 을 반환하고, 스킬 엔드포인트는 어떤 예외에도 200 + 안내 문구를 돌려준다. 카카오에 500을 주면 사용자에게는 원인 불명의 오류만 뜬다.
- **provider 만 갈아끼우면 데이터 소스가 바뀐다.** `HotelProvider.search()` 는 이미 async 라, 크롤링/LLM 으로 교체할 때 service 를 안 고쳐도 된다. 단 그 시점엔 5초를 넘기므로 카카오 **콜백(useCallback)** 전환이 필요하다.

---

## 다음 단계

- [ ] 애드픽 실제 캠페인 링크로 `data/hotels.json` 의 `target_url` 교체
- [ ] 호텔 썸네일 실제 이미지로 교체 (현재 placeholder)
- [ ] 체크인/체크아웃 날짜 파싱
- [ ] provider 교체 (아고다/부킹 API 또는 크롤링 + LLM 추천 이유)
- [ ] 항공권 도메인 추가 (`recommendations.domain` 으로 이미 구분됨)
- [ ] 애드픽 전환 리포트 → `conversions` 매칭

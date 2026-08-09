# travel-chatbot-app — 초기 기획 (호텔 MVP)

카카오톡 챗봇용 스킬 서버. FastAPI + Supabase(Postgres).
1차 목표: **"오사카 호텔 추천해줘" → 호텔 목록 카드 노출 → 사용자 클릭 → 애드픽 링크로 이동 + 클릭 로그 적재**

---

## 1. 전체 구조

```
[카카오톡] --(skill webhook)--> [FastAPI 스킬 서버] --> [Supabase]
                                      |
                                      +--> HotelProvider (1단계: 고정 JSON / 2단계: AI·크롤링)
                                      +--> AdpickLinkBuilder (제휴 링크 생성)

[사용자 카드 클릭] --> [FastAPI /r/{click_id}] --(302)--> [애드픽 딥링크] --> 아고다/부킹
                              |
                              +--> click 로그 적재
```

### 핵심 설계 판단 3가지

| 판단 | 이유 |
|---|---|
| **애드픽 링크를 카드에 직접 넣지 않고 `/r/{click_id}` 자체 리다이렉트를 경유** | 카카오 `webLink` 버튼은 브라우저를 바로 열기 때문에 **우리 서버로 콜백이 오지 않음**. 즉 "사용자가 어떤 호텔을 골랐는지"를 알 방법이 없음. 리다이렉트 1홉을 끼워야 선택 추적이 가능하고, 나중에 애드픽 링크가 바뀌어도 DB만 고치면 됨 |
| **응답은 무조건 5초 안에** | 카카오 스킬 서버 타임아웃 5초. 고정 데이터는 문제 없지만 **AI/크롤링을 붙이는 순간 초과**함. 그 시점에 `useCallback` (AI 챗봇 콜백) 방식으로 전환하는 것을 전제로 provider 인터페이스를 비동기로 설계 |
| **`hotel` 도메인을 provider 패턴으로 격리** | 나중에 `flight`, `activity`가 붙을 때 카카오 응답 조립/DB 로깅/리다이렉트는 그대로 재사용하고 provider만 추가 |

---

## 2. 대화 플로우 (MVP)

```
사용자: "오사카 호텔 추천해줘"
   ↓ 카카오 i 오픈빌더 [호텔추천] 블록 (엔티티: sys.location 또는 커스텀 city 엔티티)
   ↓ POST /api/v1/kakao/hotels/recommend
서버:
   1) 발화 로깅            → messages
   2) 도시 파싱            → "오사카" (엔티티 우선, 없으면 발화 텍스트 폴백)
   3) HotelProvider 조회   → 고정 호텔 5건
   4) recommendation + recommendation_items 저장 (클릭 전에 미리 저장)
   5) 각 item마다 click_id 발급 → 버튼 URL = https://{도메인}/r/{click_id}
   6) carousel(basicCard) JSON 응답
   ↓
카카오: 호텔 카드 5장 가로 스와이프 + 하단 quickReplies("도쿄 호텔", "후쿠오카 호텔", "다시 추천")
   ↓ 사용자가 "예약하러 가기" 클릭
   ↓ GET /r/{click_id}
서버:
   7) clicks INSERT (누가/어떤 호텔/언제)
   8) 302 → 애드픽 딥링크
```

**도시를 못 알아들었을 때**: 도시 quickReplies를 붙인 되묻기 응답 (`"어느 도시 호텔을 찾으세요?"`).

---

## 3. DB 스키마 (Supabase)

`supabase/migrations/0001_init.sql` 참고. 테이블 8개.

| 테이블 | 역할 |
|---|---|
| `users` | 카카오 `botUserKey` 기준 사용자. 개인정보 없음(카카오가 안 줌) |
| `messages` | 사용자 발화 원문 + 파싱 결과 + raw payload(디버깅용) |
| `cities` | 도시 마스터 + 별칭(`오사카`, `osaka`, `大阪`) 매칭용 |
| `hotels` | 호텔 마스터. MVP는 시드 JSON을 그대로 적재 |
| `hotel_offers` | 호텔 × 제휴사(애드픽 캠페인) 링크. 호텔 하나에 아고다/부킹 여러 개 가능 |
| `recommendations` | "이 요청에 이렇게 응답했다" 1건 |
| `recommendation_items` | 그 응답에 담긴 호텔 N건 (노출 순서, 그 시점 링크 스냅샷, click_id) |
| `clicks` | 실제 클릭. `recommendation_item_id` FK |

> `recommendation_items`에 링크를 **스냅샷**으로 남기는 게 포인트. 나중에 애드픽 캠페인이 바뀌어도 "그때 그 유저가 뭘 눌렀는지" 정확히 복원됨.

### 나중에 붙일 것 (스키마 자리만 잡아둠)
- `conversions` — 애드픽 postback/리포트로 실제 예약 전환 매칭 (`click_id` 기준)
- `flights`, `flight_offers` — 항공권 도메인. `recommendations.domain` 컬럼으로 이미 구분해둠

---

## 4. 폴더 구조

```
travel-chatbot-app/
├── app/
│   ├── main.py                     # FastAPI 엔트리
│   ├── core/
│   │   ├── config.py               # pydantic-settings 환경변수
│   │   └── logging.py
│   ├── api/v1/
│   │   ├── router.py
│   │   ├── kakao_hotel.py          # POST /kakao/hotels/recommend, /kakao/fallback
│   │   └── redirect.py             # GET /r/{click_id}
│   ├── kakao/
│   │   ├── schemas.py              # 카카오 스킬 요청 payload 모델
│   │   └── templates.py            # simpleText / basicCard carousel / quickReplies 빌더
│   ├── domain/hotel/
│   │   ├── schemas.py              # Hotel, HotelQuery
│   │   ├── service.py              # 유스케이스 (조회 + 저장 + 링크 생성)
│   │   └── providers/
│   │       ├── base.py             # HotelProvider 인터페이스 (async)
│   │       └── static_provider.py  # 고정 JSON  ← 지금
│   │       # ai_provider.py, crawler_provider.py ← 나중
│   ├── services/
│   │   ├── nlu.py                  # 도시 파싱
│   │   └── adpick.py               # 애드픽 링크 빌더
│   └── db/
│       ├── supabase_client.py      # 없으면 no-op 모드로 동작
│       └── repositories/           # users / messages / recommendations / clicks
├── data/hotels.json                # 고정 호텔 시드
├── supabase/migrations/0001_init.sql
├── tests/
└── docs/PLAN.md
```

---

## 5. 카카오 오픈빌더 설정

1. **스킬 등록**: URL `https://{도메인}/api/v1/kakao/hotels/recommend`
2. **블록 `호텔추천`**: 예시 발화 `오사카 호텔 추천해줘`, `도쿄 숙소 알려줘`, `호텔 추천`
3. **엔티티**: `sys.location` 또는 커스텀 엔티티 `city`(오사카/도쿄/후쿠오카… 별칭 포함)를 파라미터 `city`로 매핑
   - 서버는 파라미터가 비어도 **발화 텍스트에서 폴백 파싱**하므로 엔티티 설정 없이도 동작함
4. **폴백 블록**: `/api/v1/kakao/fallback`
5. 배포 후 **HTTPS 필수**, 응답 5초 제한

---

## 6. 개발 단계

- **Phase 1 (지금)** — 고정 호텔 5건 × 3도시, 캐러셀 응답, 클릭 추적, DB 적재
- **Phase 2** — 날짜/인원 파싱(체크인·체크아웃), 도시별 호텔 확대, 애드픽 실제 캠페인 링크 연결
- **Phase 3** — provider 교체: 아고다/부킹 API 또는 크롤링 + LLM 요약 추천 이유. 이때 카카오 **콜백(useCallback)** 전환
- **Phase 4** — 항공권 도메인 추가, 전환(conversion) 리포트 매칭, 재방문 유저 개인화

---

## 7. 지금 결정이 필요한 것 (열린 이슈)

1. **애드픽 링크 형태** — 캠페인별 고정 URL인지, `?subid=` 같은 서브 파라미터로 유저 구분이 가능한지. 서브 파라미터를 지원하면 `click_id`를 실어 보내 **전환까지 정확히 매칭** 가능 (`app/services/adpick.py`에 자리 준비해둠)
2. **배포처** — Railway / Fly.io / Cloudtype / Vercel(Serverless). 리다이렉트 응답이 빨라야 하니 한국·일본 리전 권장
3. **호텔 이미지** — 카카오 카드 썸네일은 외부 HTTPS URL이 필요. 제휴사 이미지 직링크 허용 여부 확인 필요 (안 되면 Supabase Storage에 올려서 사용)
4. **날짜 처리** — MVP는 날짜 없이 "추천"만 할지, `체크인/체크아웃`을 물어볼지. 애드픽 링크에 날짜를 실을 수 있으면 전환율이 오름
5. **Supabase RLS** — 서버가 service_role 키로만 접근하므로 전 테이블 RLS ON + 정책 없음(=서버 전용)으로 마이그레이션에 넣어둠. 나중에 어드민 대시보드를 붙이면 정책 추가 필요

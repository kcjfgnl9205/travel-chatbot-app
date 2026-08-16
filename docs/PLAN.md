# travel-chatbot-app — 초기 기획 (호텔 MVP)

카카오톡 챗봇용 스킬 서버. NestJS + Supabase(Postgres).
(FastAPI 로 시작했다가 전환했다 — [MIGRATION.md](MIGRATION.md))
1차 목표: **"오사카 호텔 추천해줘" → 호텔 목록 카드 노출 → 사용자 클릭 → 애드픽 링크로 이동 + 클릭 로그 적재**

DB 상세는 [DB.md](DB.md).

---

## 1. 전체 구조

```
[카카오톡] --(skill webhook)--> [NestJS 스킬 서버] --> [Supabase]
                                      |
                                      +--> HotelProvider   호텔 + 원본주소(아고다 등)
                                      |     (1단계: 고정 / 2단계: AI·크롤링)
                                      +--> AdpickClient    원본주소 → 제휴주소 변환 (캐시)

[줄 클릭] --> [/r/{clickId}] --(302)--> [애드픽 커미션 링크] --> 아고다/부킹
                        |
                        +--> click_count + 1
```

**호텔 마스터를 우리가 소유하지 않는다.** AI/크롤링이 런타임에 호텔과 원본 주소를 찾아오고, 애드픽 API 가 그걸 제휴 주소로 바꾼다. 사용자에게는 제휴 주소만 보인다.

### 핵심 설계 판단 4가지

| 판단 | 이유 |
|---|---|
| **애드픽 링크를 카드에 직접 넣지 않고 `/r/{click_id}` 자체 리다이렉트를 경유** | 카카오 `webLink` 버튼은 브라우저를 바로 열기 때문에 **우리 서버로 콜백이 오지 않음**. 즉 "사용자가 어떤 호텔을 골랐는지"를 알 방법이 없다. 리다이렉트 1홉을 끼워야 선택 추적이 되고, 링크가 바뀌어도 DB만 고치면 된다 |
| **제휴 링크 변환 결과를 `affiliate_links` 에 캐시** | 애드픽 API 는 **분당 60회** 제한이고 **180일 무클릭 링크를 삭제**한다. 호텔 5건이면 요청 1건에 5회를 쓰므로 캐시 없이는 분당 12요청에서 막힌다. `source_url` 하나당 링크 하나를 만들어 재사용하고, 미스만 동시에 변환한다 |
| **응답은 캐러셀이 아니라 `listCard` 한 장** | 호텔 추천은 **비교**가 목적이다. 캐러셀은 좌우로 스와이프해야 해서 한 번에 하나만 보이지만, listCard 는 5곳이 한 화면에 세로로 나열된다. 각 줄의 `link.web` 이 호텔별 `click_id` 를 가리켜 줄 클릭만으로 추적된다 |
| **응답은 무조건 5초 안에** | 카카오 스킬 서버 타임아웃 5초. 고정 데이터는 여유롭지만 **AI/크롤링을 붙이는 순간 초과**한다. 그 시점에 `useCallback`(AI 챗봇 콜백)으로 전환하는 것을 전제로 provider 인터페이스를 비동기로 설계했고, `recommendations.latency_ms` 로 여유를 추적한다 |
| **`hotel` 도메인을 provider 패턴으로 격리** | 나중에 `flight`, `activity` 가 붙을 때 카카오 응답 조립 / DB 로깅 / 리다이렉트 / 제휴링크 변환은 그대로 재사용하고 provider 만 추가 |

---

## 2. 대화 플로우 (MVP)

```
사용자: "오사카 호텔 추천해줘"
   ↓ 카카오 i 오픈빌더 [호텔추천] 블록
   ↓ POST /api/v1/kakao/hotels/recommend
서버:
   1) 발화 로깅                → messages
   2) 도시 파싱                → "오사카" (엔티티 우선, 없으면 발화 텍스트 폴백)
   3) HotelProvider 조회       → 호텔 5건 + 각각의 원본 주소
   4) 원본주소 → 커미션링크 변환 → affiliate_links (캐시 히트면 API 안 탐)
   5) recommendation + items 저장 (클릭 전에 미리)
   6) 각 item 마다 click_id 발급 → 줄 링크 = https://{도메인}/r/{click_id}
   7) listCard 응답 (최대 5줄)
   ↓
카카오: 호텔 5곳 리스트 + 하단 quickReplies
   ↓ 호텔 줄 클릭
   ↓ GET /r/{click_id}
서버:
   8) register_click() → click_count + 1 (DB 왕복 1회)
   9) 302 → 애드픽 커미션 링크
```

**도시를 못 알아들었을 때**: 도시 quickReplies 를 붙인 되묻기 응답.

---

## 3. 실패해도 죽지 않는다

이 서비스는 외부 의존이 3개(Supabase / 애드픽 API / AI·크롤링)라 부분 실패가 일상이다. 각각 폴백을 정해뒀다.

| 실패 | 결과 |
|---|---|
| Supabase 다운 | 호텔 목록 **정상 응답**. 그 요청만 기록 안 됨 (repository 가 예외 대신 null 반환) |
| 애드픽 API 실패 | 카드 **정상 노출**. 원본 주소로 폴백 — 수익화만 안 됨. 실패 사유는 `affiliate_links.error` 에 기록 |
| provider 결과 0건 | "아직 준비 중인 도시" 안내 + 다른 도시 quickReplies |
| 그 외 모든 예외 | 카카오에 **200 + 안내 문구**. 500 을 주면 사용자에게 원인 불명 오류만 뜬다 |

---

## 4. DB

테이블 6개(전부 사용 중). 상세는 [DB.md](DB.md).

| 그룹 | 테이블 |
|---|---|
| 캐시 | `search_cache`, `affiliate_links` |
| 행동 로그 | `users`, `messages`, `recommendations`, `recommendation_items` |

흐름: 발화 1건 → `messages` 1행 → `recommendations` 1행 → `recommendation_items` N행 → 클릭 시 그 행의 `click_count` 증가

**호텔 마스터 테이블은 없다.** 호텔 목록을 매번 AI/크롤링으로 새로 받는데 이름으로는 "같은 호텔"을 못 묶는다 — `호텔 그란비아 오사카` / `그란비아 오사카` / `Hotel Granvia Osaka` 가 전부 다른 행이 된다. 호텔 신원은 **`source_url`**(기계가 부여한 원본 주소)로 잡고, 이미 `affiliate_links` 가 `(partner, source_url)` 유니크로 그 역할을 한다. 도시 목록도 DB 대신 [`nlu.ts`](../src/modules/nlu/nlu.ts) 상수 하나로 관리한다.

**`recommendation_items` 가 설계의 중심.** `click_id` 발급 + 노출 스냅샷(호텔명/가격/원본주소/최종링크) + 미클릭 줄 기록을 동시에 한다. 덕분에 CTR 과 "그때 사용자가 본 화면"을 둘 다 복원할 수 있다.

---

## 5. 폴더 구조

```
travel-chatbot-app/
├── src/
│   ├── common/guards/              X-Skill-Token 검증
│   ├── config/                     환경변수 · DB 활성 판단
│   ├── modules/
│   │   ├── kakao/                  스킬 엔드포인트 + listCard 빌더
│   │   ├── hotel/                  유스케이스 + providers/ (static ← 지금)
│   │   ├── nlu/                    도시·인원·박수 파싱
│   │   ├── adpick/                 커미션 링크 생성
│   │   ├── affiliate/              캐시 우선 링크 해석
│   │   ├── search-cache/           검색 결과 캐시
│   │   ├── redirect/               /r/{clickId}
│   │   ├── health/                 /health, /health/db
│   │   └── database/               Supabase + repositories (@Global)
│   ├── app.module.ts
│   └── main.ts
├── data/hotels.json                static provider 데이터 (DB 시드 아님)
├── supabase/migrations/
│   └── 0001_init.sql               테이블 6개 + register_click()
├── test/                           39개
└── docs/{PLAN,DB,DEPLOY,MIGRATION}.md
```

---

## 6. 카카오 오픈빌더 설정

1. **스킬 등록**: URL `https://{도메인}/api/v1/kakao/hotels/recommend`
2. **블록 `호텔추천`**: 예시 발화 `오사카 호텔 추천해줘`, `도쿄 숙소 알려줘`
3. **엔티티**: `sys.location` 또는 커스텀 `city` 를 파라미터 `city` 로 매핑
   - 서버가 발화 텍스트에서 폴백 파싱하므로 **엔티티 없이도 동작**한다
4. **폴백 블록**: `/api/v1/kakao/fallback`
5. 배포 후 **HTTPS 필수**, 응답 **5초 제한**
6. (선택) 스킬 헤더 `X-Skill-Token` + `.env` 의 `KAKAO_SKILL_TOKEN` 으로 외부 호출 차단

---

## 7. 개발 단계

- **Phase 1 (지금)** — 고정 호텔 데이터, listCard 응답, 제휴링크 변환/캐시, 클릭 추적, DB 적재
- **Phase 2** — 애드픽 실제 API 스펙 연결, 날짜/인원 파싱(체크인·체크아웃), 썸네일 실제 이미지
- **Phase 3** — provider 교체(크롤링 또는 LLM). 결과 캐시는 이미 붙어 있으므로 provider 만 갈아끼우면 되고, 호출 로그 테이블을 그때 추가한다. 카카오 **콜백(useCallback)** 전환
- **Phase 4** — 항공권 도메인, 재방문 개인화

예약 전환 추적은 범위 밖이다. 노출 → 클릭(`recommendation_items.click_count`)까지만 본다. 필요해지면 `affiliate_links.p_data` 로 애드픽 성과 데이터를 붙일 수 있게 열어뒀다.

---

## 8. 열린 이슈

1. **애드픽 rate limit(분당 60회)** — 캐시로 대부분 막히지만, 신규 도시가 한꺼번에 들어오면 걸릴 수 있다. 현재는 실패 시 원본 주소로 폴백하고 `affiliate_links.error` 에 남긴다. 트래픽이 늘면 백그라운드 사전 변환(큐)이 필요하다
2. **호텔 이미지** — 카카오 리스트 썸네일은 외부 HTTPS URL 필요. 크롤링 이미지 직링크가 막히면 Supabase Storage 경유 필요. (listCard 는 `imageUrl` 이 줄마다 선택이라 일부만 없어도 렌더링은 된다)
3. **한 번에 5곳까지** — listCard 제한. 더 보여주려면 "더보기" 버튼으로 다음 5곳을 주는 페이지네이션이 필요하다. `recommendation_items.position` 에 이미 순서가 남으므로 이어붙이기는 어렵지 않다
4. **날짜를 원본 URL 에 넣을 것인가** (Phase 2 의 핵심 결정)

   `source_url` 이 곧 링크의 신원이라, 날짜를 URL 에 넣으면 `affiliate_links` 행이
   `호텔 수` 에서 `호텔 수 × 날짜조합 수` 로 늘어난다. 스키마는 그대로 동작하지만
   성격이 달라진다.

   | | 날짜 포함 | 미포함(호텔 페이지만) |
   |---|---|---|
   | 사용자 | 본인 날짜 가격이 바로 보임 → 전환율 높음 | 랜딩 후 날짜 재선택 → 이탈 |
   | 링크 수 | 호텔 × 날짜조합 | 호텔당 1개 |
   | rate limit | 압박 있음 (분당 60회) | 여유 |
   | 캐시 수명 | **체크아웃까지만 유효** | 사실상 무기한 |

   권장: **넣는다.** "5월 20일부터 4박"이라고 말한 사람에게 날짜 없는 페이지를 주면
   이탈한다. 인기 날짜는 반복되므로 캐시가 rate limit 을 상당히 흡수한다.

   ⚠️ **넣기로 하면 반드시 같이 고쳐야 할 것**: 지금 `affiliate_links.expires_at` 은
   `ADPICK_LINK_TTL_DAYS`(30일) 고정이다. 5/20~5/24 링크를 5/1에 만들면 5/31까지
   재사용되어 **이미 지난 날짜를 계속 보여준다.** `min(생성일 + TTL, 체크아웃일)` 로
   잘라야 한다. `search_cache` 의 TTL 도 마찬가지.
5. **배포처** — Railway / Fly.io / Cloudtype 등. 리다이렉트 응답 속도가 곧 이탈률이라 한국·일본 리전 권장
6. **AI 결과 검증** — LLM 으로 호텔을 생성하면 존재하지 않는 호텔이나 틀린 가격이 나올 수 있다. provider 를 정할 때 원본 응답을 남길 테이블을 함께 만들어 검증 로직을 얹는 게 맞다. 크롤링으로 실제 URL 을 확보하는 방식이면 이 문제는 상당 부분 사라진다
7. **도시 확장** — 도시 목록이 [`nlu.ts`](../src/modules/nlu/nlu.ts) 상수 하나에 있다. 수십 개로 늘어나면 별칭 매칭이 선형 탐색이라 느려지고, 코드 배포 없이 추가할 수 없다. 그때 DB + 캐시로 옮기는 게 맞다

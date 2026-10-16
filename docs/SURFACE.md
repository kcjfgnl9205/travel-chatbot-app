# 두 개의 봇, 한 개의 서버 — 그룹챗봇과 1:1 챗봇

> **작업 지시서다.** 지금 무엇이 어긋나 있고 어디를 고치는가를 적는다.
> 구조 설명은 [ROUTER.md](ROUTER.md), 오픈빌더에서 손댈 것은 [KAKAO-SETUP.md](KAKAO-SETUP.md).

이 문서에서 쓰는 말:

| 말 | 뜻 |
|---|---|
| **group** | 단톡방의 그룹챗봇(팀채팅 챗봇) beta. 지금 운영 중인 그것 |
| **solo** | 1:1 카카오톡 채널 챗봇. 이미 존재한다 |
| **surface** | 응답이 어느 쪽으로 나가는가. 코드에서 둘을 가르는 **유일한 값** |

---

## 0. 결론

**스킬 서버를 둘로 쪼개지 않는다. 파이프라인은 하나, 렌더러만 둘이다.
그리고 둘 중 무엇인지는 페이로드가 아니라 URL 이 정한다.**

```
POST /api/v1/kakao/router        → surface: group   (기존. 건드리지 않는다)
POST /api/v1/kakao/solo/router   → surface: solo    (신규)
```

발화 해석·캐시·검색은 한 벌 그대로 쓰고, 말풍선 JSON 을 만드는 마지막 한 단계만 갈린다.

---

## 1. ⚠️ 먼저 확인할 것 — 지금 1:1 봇은 어디를 보고 있나

1:1 봇이 **이미 있는데** 서버에는 카카오 진입점이 `/api/v1/kakao/router` 하나뿐이다.
그러면 셋 중 하나인데, 셋 다 그냥 두면 안 되는 상태다.

| 1:1 봇의 스킬 URL | 지금 일어나는 일 |
|---|---|
| **`/api/v1/kakao/router` (같은 주소)** | ⚠️ **그룹 전용 버튼이 1:1 로 나가고 있다.** `mention`·`guide` 는 그룹봇 전용 플러그인이라(§3) 말풍선이 통째로 안 그려질 수 있다. 로그에는 200 이 찍힌다 |
| 옛 엔드포인트 (`hotels/recommend` 등) | ❌ 죽어 있다. 라우터 재설계 때 사라졌다 (404) |
| 아예 스킬 미연결 / 다른 서버 | 이 문서의 작업은 **신규 추가**가 된다 |

확인 순서:

```bash
# 1. 오픈빌더에서 1:1 봇 → 설정 → 스킬 → URL 을 눈으로 본다
# 2. 서버 로그에서 두 봇의 bot.id 가 섞여 들어오는지 본다 (끝에 ! 가 붙으면 개발 채널)
#    router.controller 는 지금 bot.id 를 안 찍는다 — 1단계에서 같이 찍게 한다
```

**첫 번째 칸이면 그게 지금 가장 급한 버그다.** 아래 순서를 그대로 밟되 3단계를
먼저 당겨도 된다.

---

## 2. 왜 서버를 둘로 안 쪼개는가

쪼개면 **[search.service.ts](../src/modules/search/search.service.ts) 의 single-flight 선점이
채널별로 따로 돈다.** 같은 "오사카 호텔" 을 단톡방과 1:1 에서 비슷한 때에 물으면
AI 가 두 번 돈다 — 선점은 `search_results` 행 하나를 두고 벌이는 경쟁인데, 프로세스가
둘이면 경쟁 자체가 성립해도 **캐시 TTL·빈손 카운트(`emptyStreak`)가 두 벌로 갈린다.**

공유 서비스로 뽑아 쓸 거라면 그건 결국 "컨트롤러만 둘" 과 같다. 그게 이 문서의 결론이다.

| 단계 | group / solo |
|---|---|
| 멘션 제거 → `TRAVEL_HINT` → 의도·지명 추출 → place 정규화 | **같다** |
| 캐시 키 · 선점 · 20건 저장 · `pageOf` 페이지 자르기 | **같다** |
| 5초 예산 / `useCallback` 콜백 | **같다** |
| 말풍선 조립 ([cards.ts](../src/modules/kakao/cards.ts) · [templates.ts](../src/modules/kakao/templates.ts)) | **다르다** |

---

## 3. 무엇이 다른가 — 근거

출처는 『그룹 챗봇 beta 개발 가이드 문서』(76p, 저장소 루트).

**컴포넌트** (가이드 표 3, p.10~17)

| | group | solo |
|---|---|---|
| SimpleText · SimpleImage · TextCard · BasicCard · ListCard | O | O |
| **QuickReplies** | **X** | **O** |
| **Carousel** | **X** | **O** |
| CommerceCard | X | O |
| ItemCard | 가이드는 O 라는데 **실제로 안 그려졌다** ([FLIGHT.md](FLIGHT.md) §6) | O |

**버튼 액션** (가이드 p.19~28). 변경이력 1.5.0 이 *"그룹봇 전용 버튼 플러그인 추가"* 라고
적고 있다 — 즉 아래는 **group 에서 생긴 것들**이다.

| 액션 | 쓰는 곳 | solo |
|---|---|---|
| `mention` | [templates.ts:50](../src/modules/kakao/templates.ts#L50) — 되묻기 전부 | ❌ 쓰면 안 된다 (1:1 엔 멘션 개념이 없다) |
| `guide` | [templates.ts:66](../src/modules/kakao/templates.ts#L66) — `notUnderstoodCard` | ❌ |
| `share` | [search.service.ts:421](../src/modules/search/search.service.ts#L421) — **모든 결과 카드** | ⚠️ **확인 필요.** 같은 표에 있으나 일반 챗봇에도 있는 액션이다. 틀리면 카드가 통째로 사라진다 |
| `message` · `block` · `webLink` | 더보기·도시 선택 | ✅ 양쪽 다 |

여기서 가장 큰 차이는 버튼이 아니라 **QuickReplies 다.** group 은 퀵리플라이가 없어서
"이어서 말하기" 말풍선(`mentionCard`)을 output 한 칸 써가며 따로 세웠다. solo 는 그 칸이
그대로 돌아온다 — 카드 + 고지 + **한 칸 여유**(`MAX_OUTPUTS` 는 양쪽 다 3).

---

## 4. 왜 페이로드로 판단하지 않는가

판단 자체는 된다. 가이드 p.6 의 SkillRequest 를 보면 group 요청에는 `chat` 이 붙는다.

```json
"userRequest": {
  "chat": { "id": "9debbb…", "type": "botGroupKey" }
}
```

그런데 **solo 판정은 "chat 이 없음" 이라는 부재 추론이 된다.** 가이드 첫 장이 직접 경고한다 —
*"SkillRequest 는 하위 호환성을 유지하면서 파라미터가 추가될 수 있습니다."* 카카오가 1:1 에도
`chat` 을 추가하는 날 **모든 응답 포맷이 조용히 뒤집힌다.** 그리고 이 봇에서 포맷이 틀리면
로그는 200 이고 화면만 빈칸이다 ([KAKAO-SETUP.md](KAKAO-SETUP.md) §5) — 가장 늦게 발견되는 종류다.

URL 은 오픈빌더에서 봇마다 한 번 박는 값이고, **두 봇은 어차피 스킬을 따로 등록한다.**
공짜로 주어지는 명시적 식별자를 버리고 추론할 이유가 없다.

> **안전장치**: solo 라우트로 `chat.type === 'botGroupKey'` 가 들어오면 포맷을 자동으로
> 바꾸지 말고 **경고 로그만** 남긴다. 자동 전환은 오픈빌더 설정 실수를 숨기고, 로그는 드러낸다.

---

## 5. 코드 수정 목록

### 5-1. `Surface` 도입 — 기계적 치환

`botName: string | null` 이 이미 전 경로를 타고 흐른다. 그 파라미터를 바꾸면 분기 지점이
`templates.ts` 한 파일로 모인다.

```ts
// src/modules/kakao/surface.ts
export type SurfaceKind = 'group' | 'solo';
export interface Surface {
  kind: SurfaceKind;
  /** 봇 이름. group 에서만 멘션 안내에 쓴다. */
  botName: string | null;
}
```

| 파일 | 손대는 양 | 내용 |
|---|---|---|
| [search.types.ts](../src/modules/search/search.types.ts) | 1곳 | `RouterRequest.botName` → `surface: Surface` |
| [cards.ts](../src/modules/kakao/cards.ts) | 23곳 | 마지막 인자 `botName` → `surface` |
| [search.service.ts](../src/modules/search/search.service.ts) | 13곳 | `req.botName` → `req.surface` |
| [router.controller.ts](../src/modules/kakao/router.controller.ts) | 11곳 | `request()` 가 surface 를 채운다 |

**이 단계에서 group 동작은 1비트도 바뀌지 않아야 한다.**

> ⚠️ **기존 테스트 통과로는 그것을 보장하지 못한다.** 이 저장소에 스냅샷 테스트는 0 개이고
> ([helpers.ts](../test/helpers.ts) 는 `outputs.find(o => o.listCard)` 처럼 **골라서** 본다),
> 그래서 **말풍선 순서가 바뀌어도 · 하나 더 붙어도 · 필드가 늘어도 통과한다.**
>
> **치환보다 먼저 골든 스냅샷을 심는다:**
>
> 1. 지금 `main` 에서 `test/golden.spec.ts` 를 추가한다 — 카드 · 더보기 · 도움말 · 되묻기 ·
>    busy · 콜백 경로의 **응답 전체**를 `toMatchSnapshot()` 으로 박고 스냅샷을 커밋한다
> 2. 그 위에서 `Surface` 치환을 한다
> 3. 스냅샷이 하나라도 깨지면 그게 곧 "group 이 바뀌었다" 는 증거다
>
> 이 순서가 아니면 "영향 없음" 은 코드를 읽은 사람의 인상일 뿐이다.

### 5-2. `templates.ts` — 포맷이 갈리는 유일한 곳

> ⚠️ **공통 함수를 고쳐서 solo 를 끼우지 마라.** `skillResponse` 와 `MAX_OUTPUTS` slice 는
> group 응답도 지나가는 길이다. solo 퀵리플라이는 **별도 경로**로 세우고, 분기는 삼항의
> 거짓 가지에만 둔다 — group 가지는 글자 하나 바뀌지 않아야 한다.

| 함수 | group | solo |
|---|---|---|
| [`mentionCard`](../src/modules/kakao/templates.ts#L77) | 멘션 버튼 말풍선 | **빈 배열** (말풍선을 안 쓴다) |
| [`simpleTextWithMention`](../src/modules/kakao/templates.ts#L127) | text + 멘션 말풍선 | `simpleText` + `quickReplies` |
| [`listCard`](../src/modules/kakao/templates.ts#L190) · [`listCardWithNotice`](../src/modules/kakao/templates.ts#L219) | 끝에 멘션 말풍선 | 멘션 말풍선 제거, 필요하면 `quickReplies` |
| [`guideButton`](../src/modules/kakao/templates.ts#L66) | `action: 'guide'` | 도움말 **문구**로 대체하거나 버튼을 뺀다 |
| [`shareButton`](../src/modules/kakao/templates.ts#L105) | `action: 'share'` | §3 확인 후 결정 |

```ts
/** 대화를 이어갈 수단. group 은 말풍선 한 칸, solo 는 퀵리플라이. */
export function continueAffordance(s: Surface, suggestions: string[]): Json[] {
  return s.kind === 'group' ? [mentionCard(s.botName)] : [];
  // solo 는 outputs 가 아니라 template.quickReplies 로 들어간다 — skillResponse 쪽에서 합친다
}
```

### 5-3. 라우트 추가

```ts
@Post('solo/router')   // router.controller.ts
async routeSolo(@Body() payload: KakaoSkillPayload): Promise<t.Json> {
  return this.handle(payload, 'solo');
}
```

기존 `@Post('router')` 는 `'group'` 을 넘긴다. `dispatch` 본문은 그대로다.

---

## 6. 렌더러로 안 끝나는 것 — 함정 3개

### ① 같은 사람이 `users` 두 행이 된다

가이드 p.7 (4): *"botUserKey: 챗봇 기준 사용자 식별키. **동일한 사용자라도, 봇이 다르면
다른 ID 가 발급됨**"*. group 봇과 solo 봇은 별개 봇이므로, 한 사람이 양쪽을 쓰면
[users.repository.ts](../src/modules/database/repositories/users.repository.ts) 에 두 번 들어간다.
클릭·전환 집계가 **사람 기준으로는 중복된다.**

| 선택지 | 평가 |
|---|---|
| `users` 에 `surface` 칼럼 추가, 중복은 수용 | ✅ 지금 규모에 충분하고 싸다. **구분이 되는 것**이 중요하다 |
| `appUserId`(가이드 p.7 (5), 카카오 로그인 사용자 한정)로 나중에 병합 | 운영·개발 채널을 모두 연결해야 한다. 나중 일 |
| 무시 | ❌ 지표를 못 믿게 된다 |

### ② `KAKAO_BLOCK_ID_FALLBACK` 이 두 봇을 섞는다

```ts
// search.service.ts:407
blockId: this.config.fallbackBlockId || req.blockId,
```

**이 env 를 채워두면 두 봇 모두 그 블록을 부른다.** 더보기 버튼이 solo 에서 group 의
블록을 호출하게 되고, 그건 조용히 깨진다. 기본값이 비어 있어 지금은 `req.blockId`(요청이
알려준 폴백 블록)를 쓰므로 안전하다 — **채우지 마라.** 채워야 한다면 surface 별로 나눠야 한다.

### ③ 되묻기(pending)는 group 제약의 산물이다

[pending.ts](../src/modules/kakao/pending.ts) 와 `askPlaceNameOnly` 는 *"멘션 버튼은 `@봇이름`
까지만 넣어주고 문장은 사용자가 친다"* 는 **group 제약** 때문에 있다. solo 는 퀵리플라이가
완성된 발화를 그대로 보내므로 이 왕복이 필요 없다.

> ⚠️ **1단계에서 `pending` 을 건드리지 마라.** solo 렌더러가 퀵리플라이에 완성 문장을 박으면
> `pending` 경로는 저절로 안 타게 된다. 지금 걷어내면 group 이 같이 흔들린다.

`CursorMemory`·`PendingAskMemory` 는 `userKey` 기준인데 ①에 따라 봇이 다르면 키도 다르다 —
**두 채널이 섞이지 않는다. 코드 변경 없음.**

---

## 7. 같이 따라오는 것

- **테스트**: [router.spec.ts:69](../test/router.spec.ts#L69) `퀵리플라이를 쓰지 않는다` 가
  surface 별로 **정반대 단언**이 된다. surface 를 파라미터로 받아 두 번 도는 구조로 바꾼다
  ([helpers.ts:158](../test/helpers.ts#L158) 도 같이)
- **스웨거**: [router.example.ts](../src/modules/kakao/dto/router.example.ts) 의
  "퀵리플라이 자리를 대신하는 말풍선" 주석 4곳이 group 기준이다. solo 예시 세트를 따로 둔다
- **문서**: [ROUTER.md](ROUTER.md) 의 "진입점이 하나" 전제 →
  *"발화 해석 경로가 하나, 진입점은 봇 수만큼"*. [KAKAO-SETUP.md](KAKAO-SETUP.md) 스킬 등록 1개 → 2개.
  [HOTEL.md](HOTEL.md) · [FLIGHT.md](FLIGHT.md) 의 퀵리플라이·itemCard 금지 문구에 **"group 한정"** 단서

---

## 8. 작업 순서

| # | 할 일 | 됐는지 판별 |
|---|---|---|
| 1 | §1 확인 — 1:1 봇의 스킬 URL. 라우터에 `bot.id` 로그 추가 | 두 봇의 요청이 로그에서 구분된다 |
| 2a | **골든 스냅샷 먼저** (§5-1 경고) | `main` 에서 group 응답 전체가 스냅샷으로 박힌다 |
| 2b | `Surface` 도입 + 기계적 치환 (§5-1) | **스냅샷 무변화** + `npx tsc --noEmit` 통과 |
| 3 | `solo/router` 라우트 + solo 렌더러 (§5-2, §5-3) | solo 스펙 통과. 응답에 `mention`·`guide` 가 없다 |
| 4 | 오픈빌더 1:1 봇 스킬 URL 을 `solo/router` 로 + 배포 | 1:1 방에서 카드가 뜬다. `share` 지원 여부를 여기서 확정 |
| 5 | `users.surface` 칼럼 (§6-①) | 새 사용자 행에 surface 가 찍힌다 |

2번은 리스크 없이 지금 바로 할 수 있다. **3·4번은 §1 결과에 따라 급해질 수 있다** —
1:1 봇이 이미 `/api/v1/kakao/router` 를 보고 있다면 그건 지금 깨져 있는 것이다.

### 4번 이후 group 에 생기는 변화 — 코드 품질과 무관하다

2b 를 아무리 깨끗하게 해도, **solo 트래픽이 실제로 들어오는 순간** 아래는 설계상 따라온다.
"기존 라우터에 영향이 없다" 는 말은 **2b 까지**의 이야기다.

| 무엇 | group 에서 보이는 변화 |
|---|---|
| **공유 single-flight** | solo 사용자가 행을 선점하면 단톡방 사용자는 `먼저 찾고 있어요` 를 받는다. 캐시를 공유해서 얻는 이득의 뒷면이고, **없던 응답이 생기는 것은 맞다** |
| **DB 집계** | `users` · `messages` · `recommendations` 에 solo 트래픽이 섞인다. §6-① 의 `surface` 칼럼 전까지 group 지표는 오염된 값이다 |
| **부하** | 같은 프로세스 · 같은 5초 예산을 나눠 쓴다 |

---

## 9. 아직 모르는 것

- **`share` 가 1:1 에서 되는가.** 모든 결과 카드에 달려 있어서, 안 되면 카드가 통째로 사라진다. 4번에서 실방 확인
- **1:1 에서 콜백이 실제로 오는가.** group 조차 검증이 안 끝났다 ([ROUTER.md](ROUTER.md) §3).
  `callbackUrl` 유무로 코드가 알아서 갈리므로 깨지진 않지만, 안 오면 "다시 물어봐 주세요" 경로로 산다
- **solo 에서 Carousel · ItemCard 를 쓸 것인가.** 쓸 수 있다. group 이 못 그린다는 이유로
  listCard 에 묶여 있을 뿐이다 — 다만 **2·3번이 끝난 뒤에** 볼 일이다

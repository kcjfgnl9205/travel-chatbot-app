# 배포 — Oracle Cloud VM

Oracle Cloud 는 Railway 같은 PaaS 가 아니라 **그냥 리눅스 서버**다.
환경변수 대시보드가 없으니 시크릿을 직접 관리해야 한다. 그게 이 문서의 절반이다.

---

## 1. 시크릿을 어디에 둘 것인가

결론: **서버의 `.env` 파일**. GitHub Secrets 가 아니다.

| | 언제 읽히나 | 이 프로젝트에서 |
|---|---|---|
| 내 PC 의 `.env` | 로컬에서 `uvicorn` 돌릴 때 | 개발용 값 |
| **서버의 `.env`** | **컨테이너가 실행 중일 때** | **운영 키 ← 여기** |
| GitHub Secrets | GitHub Actions 워크플로 실행 중에만 | 나중에 CI 배포를 붙이면 SSH 키 |

**GitHub Secrets 는 런타임 저장소가 아니다.** 오라클 서버에서 도는 컨테이너는 GitHub Secrets 를 읽지 못한다. CI 를 붙이지 않았다면 쓸 일이 없다.

### 서버에서

```bash
# 경로는 ~/travel-chatbot-app 로 맞춘다 (deploy/remote.sh 의 APP_DIR 기본값)
git clone https://github.com/kcjfgnl9205/travel-chatbot-app.git ~/travel-chatbot-app
cd ~/travel-chatbot-app

cp .env.example .env
nano .env            # 실제 키 입력
chmod 600 .env       # 본인만 읽게. 이게 사실상 유일한 보호막이다
```

`.env` 는 `.gitignore` 에 있어 커밋되지 않는다. `git pull` 로 코드를 갱신해도 덮어쓰이지 않는다.

`.env` 에 넣을 값:

```bash
PUBLIC_BASE_URL=https://bot.example.com   # ★ 실제 도메인. 카드 링크가 이 주소로 나간다
DOMAIN=bot.example.com                    # ★ Caddy 인증서 발급용

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...          # Settings → API → service_role
ADPICK_API_KEY=...
KAKAO_SKILL_TOKEN=아무거나_긴_랜덤값
```

> `PUBLIC_BASE_URL` 을 `localhost` 로 두면 카카오 카드의 링크가 `localhost/r/...` 로 나가서 **사용자 폰에서 아무 데도 못 간다.** 배포 시 가장 흔한 실수.

---

## 2. Supabase 연결

1. [supabase.com](https://supabase.com) 프로젝트 생성 — **리전은 Seoul(ap-northeast-2)** 로. 오라클 서버와 가까울수록 요청당 왕복 7회가 싸진다.
2. SQL Editor 에 [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql) 붙여넣고 실행
3. 대시보드에서 두 값 복사

### `SUPABASE_URL`

**Dashboard → 프로젝트 선택 → Settings → API** 의 `Project URL`.
형태는 `https://{project-ref}.supabase.co` 이고, 브라우저 주소창의 `/project/{ref}/` 에 있는 값이 그 `ref` 다.

### `SUPABASE_SERVICE_ROLE_KEY`

**Settings → API Keys** (직접 주소: `supabase.com/dashboard/project/_/settings/api`)

Supabase 가 키 체계를 새로 바꿔서 **두 세대가 공존한다. 어느 쪽이든 이 변수에 넣으면 동작한다.**

| | 어디에 | 형태 |
|---|---|---|
| 신규 (권장) | `API Keys` 탭의 **Secret keys** | `sb_secret_...` |
| 레거시 | `Legacy API Keys` 탭의 **`service_role`** | `eyJ...` (JWT) |

레거시 키는 **곧 지원 종료 예정**이므로 새로 시작한다면 `sb_secret_...` 쪽을 쓰는 게 좋다.
환경변수 이름은 `SUPABASE_SERVICE_ROLE_KEY` 그대로 둔다 — "RLS 를 우회하는 서버 전용 키"라는 뜻으로 쓰고 있고, 두 세대 모두 그 역할이다.

> **`anon` / `publishable` 키는 안 된다.** 전 테이블이 RLS 활성 + 정책 없음이라 그 키로는 아무것도 못 읽는다.
>
> 반대로 secret / `service_role` 키는 **RLS 를 완전히 우회한다.** 클라이언트·저장소·로그·채팅 어디에도 남기면 안 된다.

연결 확인:

```bash
curl -s https://bot.example.com/health
# {"status":"ok", "db":"supabase", ...}   ← disabled(no-op) 가 아니어야 한다
```

---

## 3. 오라클 서버 준비

Always Free 기준 **Ampere A1 (ARM64)** 을 쓰게 된다. 이미지는 arm64 로 정상 빌드된다(확인함).
리전은 **춘천 또는 서울** — 리다이렉트 응답 속도가 곧 이탈률이다.

### Docker 설치 (Ubuntu 22.04/24.04)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

### ⚠️ 포트를 두 군데서 열어야 한다

오라클에서 제일 많이 막히는 지점이다. **한 군데만 열면 안 된다.**

**(1) 콘솔** — VCN → Security List → Ingress Rules 에 추가

| Source | Protocol | Port |
|---|---|---|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

**(2) 인스턴스 방화벽** — 오라클 이미지는 iptables 가 기본으로 막고 있다

```bash
# Ubuntu
sudo iptables -I INPUT 1 -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo apt install -y iptables-persistent && sudo netfilter-persistent save

# Oracle Linux
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

### 도메인 (Cloudflare)

카카오 스킬 서버는 **HTTPS 필수**다.

**1) DNS 레코드 추가** — Cloudflare 대시보드 → 해당 도메인 → DNS → Records

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `bot` (또는 `@`) | 오라클 인스턴스 공인 IP | **DNS only (회색 구름)** |

**2) `.env` 에 반영**

```bash
DOMAIN=bot.example.com
PUBLIC_BASE_URL=https://bot.example.com
```

**3) `docker compose up -d`** → Caddy 가 Let's Encrypt 인증서를 자동 발급한다.

```bash
docker compose logs caddy | grep -i certificate
curl -sI https://bot.example.com/health | head -1
```

#### ⚠️ 처음엔 반드시 "DNS only(회색)" 로

프록시(주황 구름)를 켠 채로 시작하면 인증서 발급이 실패하거나 **무한 리다이렉트**에 빠진다.
Cloudflare 가 자체 인증서로 TLS 를 끊고 오리진으로 다시 붙는 구조인데,
SSL/TLS 모드가 `Flexible` 이면 오리진에 HTTP 로 오고 → Caddy 가 HTTPS 로 리다이렉트 →
Cloudflare 가 다시 HTTP 로 요청하는 루프가 된다.

인증서를 받은 뒤 프록시를 켜고 싶다면 **반드시 이 순서로**:

1. 회색 구름 상태에서 `https://도메인/health` 가 뜨는 것 확인
2. SSL/TLS → Overview → **Full (strict)** 로 변경 (Flexible 절대 금지)
3. 그 다음 주황 구름으로 전환

#### ⚠️ 프록시를 켤 거면 봇 방어를 풀어라

Cloudflare 의 Bot Fight Mode / Managed Challenge 는 **카카오 서버의 요청을 봇으로 판단해
막을 수 있다.** 그러면 챗봇이 조용히 죽는다(카카오 쪽에는 그냥 타임아웃으로 보인다).

Security → WAF → Custom rules 에 예외를 둔다.

```
(http.request.uri.path contains "/api/v1/kakao/")  →  Skip: All remaining custom rules, Bot Fight Mode
```

리다이렉트 경로(`/r/*`)도 사용자 브라우저가 직접 타므로 챌린지가 걸리면 이탈한다. 같이 예외 처리하는 게 안전하다.

> 프록시가 굳이 필요 없다면 **회색 구름 그대로 두는 게 가장 단순하다.** Caddy 가
> 인증서를 알아서 갱신하고, 카카오·애드픽 요청 경로에 변수가 하나 줄어든다.

---

## 4. 실행

```bash
cd ~/travel-chatbot-app
docker compose up -d --build
docker compose logs -f
```

```
[app]   Uvicorn running on http://0.0.0.0:8000
[caddy] certificate obtained successfully
```

확인:

```bash
curl -s https://bot.example.com/health
curl -s -X POST https://bot.example.com/api/v1/kakao/hotels/recommend \
  -H 'content-type: application/json' \
  -H "X-Skill-Token: $KAKAO_SKILL_TOKEN" \
  -d '{"userRequest":{"utterance":"오사카 호텔 추천해줘","user":{"properties":{"botUserKey":"u1"}}}}'
```

### 갱신

```bash
git pull && docker compose up -d --build
```

`.env` 는 건드려지지 않는다.

---

## 5. main 에 push 하면 자동 배포

`.github/workflows/deploy.yml` 이 이미 들어 있다. `main` 에 push 하면
**테스트 → SSH 접속 → `git pull` → 재빌드 → 헬스체크** 까지 자동으로 돈다.
테스트가 깨지면 배포하지 않는다.

### 왜 이미지를 CI 에서 안 굽고 서버에서 빌드하나

오라클 Always Free 는 **ARM64** 인데 GitHub Actions 기본 러너는 x86 이다.
크로스 빌드(QEMU)는 몇 배로 느리다. 우리 이미지는 `pip install` 뿐이라
서버에서 굽는 게 훨씬 빠르고 단순하다.

### 서버 준비

배포 전용 SSH 키를 만든다 (개인 키를 재사용하지 말 것).

```bash
# 로컬에서
ssh-keygen -t ed25519 -f ~/.ssh/travel_deploy -N "" -C "github-actions-deploy"

# 공개 키를 서버에 등록
ssh-copy-id -i ~/.ssh/travel_deploy.pub ubuntu@<서버IP>
```

서버에 저장소가 `~/travel-chatbot-app` 에 있어야 한다(다른 경로면 `APP_DIR` 환경변수).

### GitHub Secrets 등록

저장소 → Settings → Secrets and variables → **Actions** → New repository secret

| 이름 | 값 |
|---|---|
| `SSH_HOST` | 오라클 인스턴스 공인 IP |
| `SSH_USER` | `ubuntu` (Oracle Linux 면 `opc`) |
| `SSH_KEY` | `cat ~/.ssh/travel_deploy` **전체** (`-----BEGIN...` 포함) |
| `SSH_KNOWN_HOSTS` | `ssh-keyscan -H <서버IP>` 결과 (선택, 권장) |
| `SSH_PORT` | 22 가 아니면 (선택) |

**여기가 GitHub Secrets 를 쓰는 유일한 곳이다.** 앱 시크릿(Supabase·애드픽)은
서버의 `.env` 에 있고 GitHub 은 알 필요가 없다.

### 동작 확인

```bash
git commit --allow-empty -m "test: 배포 확인" && git push
```

저장소 Actions 탭에서 진행 상황을 본다. 수동 실행은 Actions → `test & deploy` → Run workflow.

### 수동 배포

```bash
ssh ubuntu@<서버IP>
cd ~/travel-chatbot-app && bash deploy/remote.sh
```

> `deploy/remote.sh` 는 `git reset --hard origin/main` 을 쓴다. **서버는 읽기 전용으로 취급**하고
> 서버에서 코드를 직접 고치지 않는다. `.env` 는 추적 대상이 아니라 그대로 남는다.

---

## 6. 구성

```
인터넷 → :443 Caddy (TLS 종료, 자동 인증서)
              ↓ 내부 네트워크
           app:8000 (uvicorn, 비루트 유저, healthcheck)
              ↓
           Supabase (Seoul)
```

`app` 컨테이너는 `expose` 만 하고 호스트 포트를 열지 않는다. **Caddy 를 통해서만 들어온다.**
컨테이너는 `appuser`(uid 10001) 로 돌고 루트가 아니다.

---

## 7. 배포 후 체크리스트

- [ ] `chmod 600 .env`
- [ ] `PUBLIC_BASE_URL` 이 실제 HTTPS 도메인인가 (localhost 아님)
- [ ] `/health` 가 `"db":"supabase"` 인가 (`disabled(no-op)` 면 키가 안 먹은 것)
- [ ] `KAKAO_SKILL_TOKEN` 설정 + 오픈빌더 스킬 헤더에 같은 값 → 스킬 URL 무단 호출 차단
- [ ] 오픈빌더 스킬 URL 을 `https://{도메인}/api/v1/kakao/hotels/recommend` 로 등록
- [ ] 카드 링크를 실제로 눌러 애드픽까지 이동되는지 확인
- [ ] Supabase Table Editor 에서 `messages` / `recommendation_items` 에 행이 쌓이는지 확인

## 8. 안 될 때

| 증상 | 원인 |
|---|---|
| 인증서 발급 실패 | 80/443 이 **두 군데**(콘솔 + iptables) 다 열렸는지. DNS 전파 대기 |
| 무한 리다이렉트 | Cloudflare SSL/TLS 모드가 `Flexible`. **Full (strict)** 로 바꾼다 |
| 프록시 켠 뒤 카카오가 응답 없음 | Bot Fight Mode 가 카카오 요청을 막는 중. `/api/v1/kakao/*` WAF 예외 |
| Actions 는 성공인데 서버가 그대로 | `SSH_HOST` 가 다른 서버이거나 저장소 경로가 `~/travel-chatbot-app` 이 아님 |
| Actions 에서 Permission denied (publickey) | `SSH_KEY` 에 개인 키 **전문**(BEGIN/END 줄 포함)을 넣었는지. 공개 키를 넣으면 안 된다 |
| 카카오에서 타임아웃 | 응답 5초 제한. `recommendations.latency_ms` 확인 |
| 카드는 뜨는데 링크가 안 열림 | `PUBLIC_BASE_URL` 이 localhost 로 남아 있음 |
| `db: disabled(no-op)` | `SUPABASE_*` 미설정. 챗봇은 돌지만 아무것도 기록되지 않는다 |
| 애드픽 링크가 원본 주소로 나감 | `ADPICK_API_KEY` 미설정 → 폴백. `affiliate_links.error` 확인 |

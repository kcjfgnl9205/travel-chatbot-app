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
mkdir -p ~/travel-chatbot && cd ~/travel-chatbot
git clone https://github.com/kcjfgnl9205/travel-chatbot-app.git .

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
3. **Settings → API** 에서 두 값 복사
   - `Project URL` → `SUPABASE_URL`
   - `service_role` **secret** → `SUPABASE_SERVICE_ROLE_KEY`

> `anon` 키가 아니라 **`service_role`** 이다. 전 테이블이 RLS 활성 + 정책 없음이라 `anon` 으로는 아무것도 못 읽는다.
>
> 반대로 `service_role` 은 RLS 를 완전히 우회한다. **클라이언트·저장소·로그 어디에도 남기면 안 된다.**

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

### 도메인

카카오 스킬 서버는 **HTTPS 필수**다. 도메인 A 레코드를 인스턴스 공인 IP 로 지정한다.
Caddy 가 Let's Encrypt 인증서를 자동 발급·갱신하므로 별도 작업은 없다.

---

## 4. 실행

```bash
cd ~/travel-chatbot
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

## 5. 구성

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

## 6. 배포 후 체크리스트

- [ ] `chmod 600 .env`
- [ ] `PUBLIC_BASE_URL` 이 실제 HTTPS 도메인인가 (localhost 아님)
- [ ] `/health` 가 `"db":"supabase"` 인가 (`disabled(no-op)` 면 키가 안 먹은 것)
- [ ] `KAKAO_SKILL_TOKEN` 설정 + 오픈빌더 스킬 헤더에 같은 값 → 스킬 URL 무단 호출 차단
- [ ] 오픈빌더 스킬 URL 을 `https://{도메인}/api/v1/kakao/hotels/recommend` 로 등록
- [ ] 카드 링크를 실제로 눌러 애드픽까지 이동되는지 확인
- [ ] Supabase Table Editor 에서 `messages` / `recommendation_items` 에 행이 쌓이는지 확인

## 7. 안 될 때

| 증상 | 원인 |
|---|---|
| 인증서 발급 실패 | 80/443 이 **두 군데**(콘솔 + iptables) 다 열렸는지. DNS 전파 대기 |
| 카카오에서 타임아웃 | 응답 5초 제한. `recommendations.latency_ms` 확인 |
| 카드는 뜨는데 링크가 안 열림 | `PUBLIC_BASE_URL` 이 localhost 로 남아 있음 |
| `db: disabled(no-op)` | `SUPABASE_*` 미설정. 챗봇은 돌지만 아무것도 기록되지 않는다 |
| 애드픽 링크가 원본 주소로 나감 | `ADPICK_API_KEY` 미설정 → 폴백. `affiliate_links.error` 확인 |

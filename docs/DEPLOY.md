# 배포 — Oracle Cloud VM

Oracle Cloud 는 Railway 같은 PaaS 가 아니라 **그냥 리눅스 서버**다.
환경변수 대시보드가 없으니 시크릿을 직접 관리해야 한다. 그게 이 문서의 절반이다.

---

## 1. 시크릿을 어디에 둘 것인가

결론: **컨테이너는 서버의 `.env` 파일만 읽는다.** 다만 DB 접속 정보(`MYSQL_*`)와
`OPENAI_API_KEY` 는 **GitHub Secrets 가 원본**이고, 배포할 때 Actions 가 서버 `.env` 에 옮겨 적는다.

| | 언제 읽히나 | 이 프로젝트에서 |
|---|---|---|
| 내 PC 의 `.env` | 로컬에서 `npm run start:dev` 할 때 | 개발용 값 |
| **서버의 `.env`** | **컨테이너가 실행 중일 때** | **운영 키 ← 컨테이너는 여기만 본다** |
| **GitHub Secrets** | GitHub Actions 워크플로 실행 중에만 | SSH 키 + **`MYSQL_*` · `OPENAI_API_KEY` 의 원본** |

**GitHub Secrets 는 런타임 저장소가 아니다.** 오라클 서버에서 도는 컨테이너는 GitHub Secrets 를 직접 읽지 못한다.
그래서 배포 잡이 [`deploy/write-env.sh`](../deploy/write-env.sh) 로 그 값들을 서버 `.env` 에 덮어쓴다 —
**서버에서 손으로 고쳐도 다음 배포가 시크릿 값으로 되돌린다.** 바꾸려면 시크릿을 바꾼다.
시크릿이 비어 있으면 서버 값을 그대로 둔다. 나머지(애드픽·카카오)는 지금도 서버 `.env` 가 원본이다.

> ⚠️ **`OPENAI_API_KEY` 가 목록에 있는 이유.** 2026-11-04 에 서버 `.env` 를 손으로 고치다
> 키 끝에 글자 하나가 붙어 모든 검색이 401 이 됐다. 원본이 그 파일뿐이라 되돌릴 데가
> 없었고, OpenAI 키는 발급 때 한 번만 보여주므로 **새로 발급해야 했다.** 시크릿에
> 넣어두면 배포 한 번으로 돌아온다.

### 서버에서

```bash
# 경로는 /opt/gajago 로 맞춘다 (deploy/remote.sh 의 APP_DIR 기본값)
sudo git clone https://github.com/kcjfgnl9205/travel-chatbot-app.git /opt/gajago
cd /opt/gajago

cp .env.example .env
nano .env            # 실제 키 입력
chmod 600 .env       # 본인만 읽게. 이게 사실상 유일한 보호막이다
```

`.env` 는 `.gitignore` 에 있어 커밋되지 않는다. `git pull` 로 코드를 갱신해도 덮어쓰이지 않는다.

`.env` 에 넣을 값:

```bash
PUBLIC_BASE_URL=https://bot.example.com   # ★ 실제 도메인. 카드 링크가 이 주소로 나간다
DOMAIN=bot.example.com                    # ★ Caddy 인증서 발급용

MYSQL_HOST=10.0.1.23                      # HeatWave 사설 IP (2절)
MYSQL_USER=travel_app
MYSQL_PASSWORD=...
MYSQL_DATABASE=travel
ADPICK_API_KEY=...
KAKAO_SKILL_TOKEN=아무거나_긴_랜덤값
```

> `PUBLIC_BASE_URL` 을 `localhost` 로 두면 카카오 카드의 링크가 `localhost/r/...` 로 나가서 **사용자 폰에서 아무 데도 못 간다.** 배포 시 가장 흔한 실수.

---

## 2. MySQL (OCI HeatWave) 연결

DB 는 **OCI MySQL HeatWave** 다. 앱 서버(`ap-chuncheon-1`)와 **같은 VCN** 안에 있고,
앱은 사설 IP 로 붙는다 — 공인 주소가 없다. 예전 Supabase 는 요청당 왕복 7회 × 약 50ms 가
응답시간과 처리량 천장을 정했다 ([LOADTEST.md](LOADTEST.md)). 같은 VCN 이면 왕복이 1ms 안쪽이다.

1. OCI 콘솔 → MySQL HeatWave → DB 시스템 생성. **앱 서버와 같은 VCN** 을 고른다
2. DB 서브넷의 Security List 에 Ingress 추가 — Source: 앱 서버 서브넷 CIDR, TCP **3306**
3. 데이터베이스와 앱 계정을 만든다 (관리자 계정으로 한 번):

   ```sql
   CREATE DATABASE travel;
   CREATE USER 'travel_app'@'%' IDENTIFIED BY '<비밀번호>';
   GRANT ALL PRIVILEGES ON travel.* TO 'travel_app'@'%';
   ```

4. **GitHub Secrets 에 등록한다** (저장소 → Settings → Secrets and variables → Actions).
   배포할 때 서버 `.env` 에 옮겨 적힌다 — 서버에서 직접 고치지 않는다.

   | 이름 | 값 |
   |---|---|
   | `MYSQL_HOST` | HeatWave **사설 IP** (콘솔 → DB 시스템 → 연결) |
   | `MYSQL_PORT` | `3306` (비우면 서버 값, 없으면 3306) |
   | `MYSQL_USER` | `travel_app` |
   | `MYSQL_PASSWORD` | 비밀번호. ⚠️ **작은따옴표(`'`)는 못 쓴다** — 배포가 멈춘다 |
   | `MYSQL_DATABASE` | `travel` |

5. **스키마는 배포가 적용한다.** `deploy/remote.sh` 가 새 컨테이너를 띄우기 **전에**
   `node dist/migrate` 를 돌려 [`db/mysql/*.sql`](../db/mysql/) 을 번호순으로 적용하고
   `schema_migrations` 에 기록한다. 실패하면 배포가 멈추고 돌던 컨테이너는 그대로다.

   > ⚠️ **적용된 파일은 고치지 않는다.** 바꿀 게 있으면 `0002_*.sql` 을 새로 만든다.
   > 러너는 파일 이름으로 적용 여부를 가린다 — 고친 내용은 운영에 영영 안 들어간다
   > (내용 해시가 달라지면 배포 로그에 경고는 뜬다).

연결 확인:

```bash
curl -s https://bot.nolmoa.com/health/db
# {"status":"ok","latencyMs":..,"tables":{...}}   ← 실패하면 hint 가 원인을 짚는다
```

Supabase 에서 데이터를 옮기는 절차는 **[MIGRATION-MYSQL.md](MIGRATION-MYSQL.md)**.

---

## 3. 오라클 서버 준비

현재 쓰는 것은 **`VM.Standard.A1.Flex` — Ampere A1 (ARM64), OCPU 1 · RAM 6GB,
`ap-chuncheon-1`(춘천), Ubuntu 24.04** 다. 이미지는 arm64 로 정상 빌드된다(확인함).

> ⚠️ **OCPU 1 은 vCPU 1 이 아니다.** Ampere 는 하이퍼스레딩이 없어 OCPU 1 =
> **물리 코어 1개**다. 그래서 작아 보여도 `/health` 기준 500 req/s 를 낸다 —
> [부하 시험](LOADTEST.md) 참고. 챗봇 응답 한계는 서버가 아니라 DB 왕복이 정한다.

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
cd /opt/gajago
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
**테스트 ∥ 이미지 빌드(GHCR push) → SSH 접속 → 이미지 받기 → 교체 → 헬스체크** 까지 자동으로 돈다.
테스트가 깨지면 배포하지 않는다.

```
GitHub Actions                          서버 (/opt/gajago)
  test   ─┐
  build  ─┤ ghcr.io/kcjfgnl9205/travel-chatbot-app:<커밋SHA>
          └─ deploy ── SSH ──▶  git reset → docker login(잡 토큰) → pull → up -d --no-build
```

### 왜 이미지를 CI 에서 굽나

**느린 서버에서 굽지 않기 위해서다.** 서버에서 굽던 빌드가 10분을 넘겨
`Run Command Timeout` 으로 끊긴 적이 있다(echo 한 줄에 16초). 지금은 러너가 굽고
서버는 받아서 갈아끼우기만 한다.

- 이미지는 **커밋 SHA 태그만** 붙는다(`latest` 없음). 서버는 지금 것과 직전 것 하나를 남긴다.
- 서버 로그인은 **그 잡의 `GITHUB_TOKEN`** 으로 하고 끝나면 로그아웃한다. 서버에 PAT 를 둘 필요가 없다.
- ⚠️ **서버 CPU 와 이미지 플랫폼이 맞아야 한다.** 현재 서버는 Ampere ARM64 이므로
  기본값이 `linux/arm64` 다. x86 서버로 옮기면 저장소 Settings → Variables 에
  `DEPLOY_PLATFORM=linux/amd64` 를 넣는다. 안 맞으면 `exec format error` 로 안 뜬다.

되돌리기:

```bash
cd /opt/gajago
echo <PAT(read:packages)> | docker login ghcr.io -u <github 아이디> --password-stdin
IMAGE_TAG=<되돌릴 커밋 SHA 전체> bash deploy/remote.sh
docker logout ghcr.io
```

> `IMAGE_TAG` 가 origin/main 과 다른 커밋이면 **저장소도 그 커밋으로 맞춘다**(detached).
> 이미지만 과거로 돌리고 compose·nginx·마이그레이션은 현재로 두면 무엇이 서빙 중인지
> 알 수 없게 되기 때문이다. 다음 정상 배포에서 자동으로 `main` 으로 돌아온다.

### 배포가 실패하면 자동으로 되돌린다

이미지를 받아 **컨테이너를 교체한 뒤** 앱이 부팅에 실패하면 서비스가 내려간다 —
예전처럼 "빌드가 깨져서 옛 컨테이너가 살아 있는" 상황이 아니다. 그래서 헬스체크가
30회(약 60초) 실패하면 **갈아끼우기 직전에 돌던 이미지로 되돌린다.**

```
▸ 헬스체크
  헬스체크 실패. 로그:
  ...
  직전 이미지로 되돌린다: ghcr.io/kcjfgnl9205/travel-chatbot-app:<이전SHA>
  앱 정상 (3회차)
  되돌렸다 — 서비스는 직전 버전으로 돌아갔다.
```

되돌린 뒤에도 배포는 **실패로 끝난다**(exit 1). Actions 는 빨갛게 뜨고, 서비스는 살아 있다.

⚠️ 직전 이미지가 없거나(첫 배포) 방금 올린 것과 같으면 되돌릴 곳이 없다. 그때는
로그만 남기고 끝나므로 서버를 직접 봐야 한다.

### ⚠️ nginx 설정은 배포가 건드리지 않는다

`deploy/nginx/*.conf` 를 고쳐 배포해도 **서버에 복사하지 않으면 아무 일도 일어나지 않는다.**
실제로 "점검 중" 폴백을 넣고도 한동안 적용이 안 됐다. 그래서 배포 끝에 저장소 파일과
설치된 파일을 비교해 **다르면 경고만** 찍는다:

```
▸ nginx 설정 확인
  ⚠️ /etc/nginx/sites-available/bot-nolmoa.conf 가 저장소와 다르다. 반영하려면:
     sudo cp /opt/gajago/deploy/nginx/bot-nolmoa.conf /etc/nginx/sites-available/ \
       && sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` 가 실패하면 `&&` 때문에 reload 가 안 돌아 **지금 설정이 그대로 유지된다.**
`reload` 는 `restart` 가 아니라서 연결도 안 끊긴다.

### 서버 준비

배포 전용 SSH 키를 만든다 (개인 키를 재사용하지 말 것).

```bash
# 로컬에서
ssh-keygen -t ed25519 -f ~/.ssh/travel_deploy -N "" -C "github-actions-deploy"

# 공개 키를 서버에 등록
ssh-copy-id -i ~/.ssh/travel_deploy.pub ubuntu@<서버IP>
```

서버에 저장소가 `/opt/gajago` 에 있어야 한다(다른 경로면 `APP_DIR` 환경변수).

### GitHub Secrets 등록

저장소 → Settings → Secrets and variables → **Actions** → New repository secret

| 이름 | 값 |
|---|---|
| `SSH_HOST` | 오라클 인스턴스 공인 IP |
| `SSH_USER` | `ubuntu` (Oracle Linux 면 `opc`) |
| `SSH_KEY` | `cat ~/.ssh/travel_deploy` **전체** (`-----BEGIN...` 포함) |
| `SSH_KNOWN_HOSTS` | `ssh-keyscan -H <서버IP>` 결과 (선택, 권장) |
| `SSH_PORT` | 22 가 아니면 (선택) |
| `MYSQL_HOST` · `MYSQL_PORT` · `MYSQL_USER` · `MYSQL_PASSWORD` · `MYSQL_DATABASE` | [2절](#2-mysql-oci-heatwave-연결) 참고. 배포가 서버 `.env` 에 옮겨 적는다 |
| `OPENAI_API_KEY` | platform.openai.com 의 키. **복사 버튼으로** 가져온다 — 화면에서 긁으면 잘린다 |

앱 시크릿 중 **DB 와 OpenAI 키만** GitHub Secrets 가 원본이다. 애드픽·카카오는 서버 `.env` 에 있다.

### 동작 확인

```bash
git commit --allow-empty -m "test: 배포 확인" && git push
```

저장소 Actions 탭에서 진행 상황을 본다. 수동 실행은 Actions → `test & deploy` → Run workflow.

### 수동 배포

```bash
ssh ubuntu@<서버IP>
cd /opt/gajago && bash deploy/remote.sh
```

> `deploy/remote.sh` 는 `git reset --hard origin/main` 을 쓴다. **서버는 읽기 전용으로 취급**하고
> 서버에서 코드를 직접 고치지 않는다. `.env` 는 추적 대상이 아니라 그대로 남는다.

> ⚠️ **nginx 설정은 배포 스크립트가 안 건드린다.** `deploy/nginx/bot-nolmoa.conf` 를
> 고쳤으면 서버에서 직접 복사하고 리로드해야 한다:
>
> ```bash
> sudo cp deploy/nginx/bot-nolmoa.conf /etc/nginx/sites-available/
> sudo nginx -t && sudo systemctl reload nginx
> ```

**손으로 돌리면 이미지 빌드 안에서 테스트가 같이 돈다.** 깨진 커밋을 막는 그물이고,
서버에서 직접 배포할 때는 그게 유일한 그물이라 기본값으로 둔다. 대신 느린 서버에서
몇 분이 더 걸린다.

CI 는 서버에서 빌드하지 않는다(위 "왜 이미지를 CI 에서 굽나"). 손으로 돌리는 이 길은
`IMAGE_TAG` 없이 부를 때만 탄다.

```bash
# 이미 CI 가 검사한 커밋을 급히 올릴 때
SKIP_TESTS=1 bash deploy/remote.sh
```

---

## 6. 구성

```
인터넷 → :443 Caddy (TLS 종료, 자동 인증서)
              ↓ 내부 네트워크
           app:8000 (Nest, 비루트 유저, healthcheck)
              ↓
           MySQL HeatWave (같은 VCN, 사설 IP)
```

`app` 컨테이너는 `expose` 만 하고 호스트 포트를 열지 않는다. **Caddy 를 통해서만 들어온다.**
컨테이너는 `appuser`(uid 10001) 로 돌고 루트가 아니다.

---

## 7. 배포 후 체크리스트

- [ ] `chmod 600 .env`
- [ ] `PUBLIC_BASE_URL` 이 실제 HTTPS 도메인인가 (localhost 아님)
- [ ] `/health` 가 `"db":"mysql"` 인가 (`disabled(no-op)` 면 `MYSQL_*` 가 안 먹은 것)
- [ ] `KAKAO_SKILL_TOKEN` 설정 + 오픈빌더 스킬 헤더에 같은 값 → 스킬 URL 무단 호출 차단
- [ ] 오픈빌더 스킬 URL 을 `https://{도메인}/api/v1/kakao/hotels/recommend` 로 등록
- [ ] 카드 링크를 실제로 눌러 애드픽까지 이동되는지 확인
- [ ] `messages` / `recommendation_items` 에 행이 쌓이는지 확인 (`SELECT COUNT(*) ...`)
- [ ] 배포 로그에 `▸ 스키마 마이그레이션` 이 성공으로 찍혔는가

## 8. 안 될 때

| 증상 | 원인 |
|---|---|
| 인증서 발급 실패 | 80/443 이 **두 군데**(콘솔 + iptables) 다 열렸는지. DNS 전파 대기 |
| 무한 리다이렉트 | Cloudflare SSL/TLS 모드가 `Flexible`. **Full (strict)** 로 바꾼다 |
| 프록시 켠 뒤 카카오가 응답 없음 | Bot Fight Mode 가 카카오 요청을 막는 중. `/api/v1/kakao/*` WAF 예외 |
| Actions 는 성공인데 서버가 그대로 | `SSH_HOST` 가 다른 서버이거나 저장소 경로가 `/opt/gajago` 가 아님 |
| Actions 에서 Permission denied (publickey) | `SSH_KEY` 에 개인 키 **전문**(BEGIN/END 줄 포함)을 넣었는지. 공개 키를 넣으면 안 된다 |
| 카카오에서 타임아웃 | 응답 5초 제한. `recommendations.latency_ms` 확인 |
| 카드는 뜨는데 링크가 안 열림 | `PUBLIC_BASE_URL` 이 localhost 로 남아 있음 |
| `db: disabled(no-op)` | `MYSQL_HOST`/`MYSQL_USER` 미설정. 챗봇은 돌지만 아무것도 기록되지 않는다 |
| 배포가 `마이그레이션 실패` 에서 멈춤 | DB 에 못 붙었거나 SQL 오류. 로그의 에러 코드를 본다 — `ECONNREFUSED`/`ETIMEDOUT` 이면 Security List 3306, `ER_ACCESS_DENIED` 면 계정. 돌던 컨테이너는 그대로라 서비스는 산다 |
| 애드픽 링크가 원본 주소로 나감 | `ADPICK_API_KEY` 미설정 → 폴백. `affiliate_links.error` 확인 |

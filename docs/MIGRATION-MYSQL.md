# Supabase → MySQL(HeatWave) 이전

한 번만 하는 작업이다. 끝나면 이 문서와 `scripts/copy-from-supabase.ts`, `supabase/migrations/` 는 지워도 된다.

**순서가 중요하다.** 앱을 MySQL 로 바꾸기 **전에** 데이터부터 옮긴다. 거꾸로 하면 바꾼 순간부터
관광지 카드가 비고(목록이 `attractions` 에 있다), 이미 나간 카드의 `/r/{clickId}` 링크가 404 가 된다.

```
1. DB·계정 만들기           HeatWave
2. SSH 터널                 내 맥 → 앱 서버 → HeatWave (DB 가 VCN 안에만 있다)
3. 스키마 적용              npm run db:migrate
4. 데이터 복사 (1차)         npm run db:copy-from-supabase
5. GitHub Secrets 에 MYSQL_*  배포가 서버 .env 에 옮겨 적는다
6. push → 배포              여기서 앱이 MySQL 로 바뀐다
7. 데이터 복사 (2차)         4~6 사이에 Supabase 에 쌓인 행을 따라잡는다
8. 확인
```

---

## 1. DB·계정 만들기

[DEPLOY.md 2절](DEPLOY.md#2-mysql-oci-heatwave-연결) 의 1~3 단계. Security List 의 3306 은 **앱 서버 서브넷**에서만 연다.

## 2. SSH 터널

HeatWave 는 공인 주소가 없다. 앱 서버를 거쳐 내 맥의 `3307` 을 HeatWave 의 `3306` 에 잇는다.
**창 하나를 이걸로 띄워두고** 나머지는 다른 창에서 한다.

```bash
ssh -N -L 3307:<HeatWave 사설 IP>:3306 ubuntu@<앱 서버 IP>
```

붙는지 확인:

```bash
mysql -h 127.0.0.1 -P 3307 -u travel_app -p travel -e "select version()"
```

## 3. 스키마 적용

```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=travel_app MYSQL_PASSWORD='...' MYSQL_DATABASE=travel \
  npm run db:migrate
# ▸ 마이그레이션 1개 적용
```

배포가 같은 러너를 돌리므로 6단계에서는 "새로 적용할 것 없음" 으로 지나간다.

## 4. 데이터 복사 (1차)

로컬 `.env` 에 `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` 가 있어야 한다(읽기 전용으로 쓴다).
MySQL 쪽은 명령줄 값이 `.env` 를 이긴다.

```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=travel_app MYSQL_PASSWORD='...' MYSQL_DATABASE=travel \
  npm run db:copy-from-supabase
```

```
▸ Supabase → MySQL (127.0.0.1/travel)
  users                  supabase     812 · mysql     812 · 이번에 넣음    812 / 읽음 812
  places                 supabase     241 · mysql     241 · ...
  ...
▸ 전 테이블 행 수 일치
```

- **넣기만 한다.** 같은 PK 가 이미 있으면 건너뛴다. 몇 번을 다시 돌려도 안전하다.
- 칸 목록은 MySQL 테이블에서 읽는다. Supabase 에만 남은 옛 칸은 버린다.
- 시각은 UTC 로 들어간다(`timestamptz` → `DATETIME(3)`, 마이크로초는 밀리초로 잘린다).
- 앱이 아직 Supabase 에 쓰는 중이라 `⚠️ 다름` 이 몇 줄 떠도 정상이다 — 7단계에서 맞춘다.

## 5. GitHub Secrets 에 `MYSQL_*`

저장소 → Settings → Secrets and variables → **Actions** → New repository secret

| 이름 | 값 |
|---|---|
| `MYSQL_HOST` | HeatWave 사설 IP — ⚠️ `127.0.0.1` 이 아니다. 서버는 터널 없이 바로 붙는다 |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | `travel_app` |
| `MYSQL_PASSWORD` | 비밀번호 (작은따옴표 `'` 는 못 쓴다) |
| `MYSQL_DATABASE` | `travel` |

배포 잡이 이 값을 서버 `.env` 에 옮겨 적은 뒤 마이그레이션·기동을 한다. 그러니 **서버 `.env` 를 손으로 고칠 필요는 없다.**

서버 `.env` 의 `SUPABASE_*` 는 **7단계가 끝날 때까지 지우지 않는다** — 새 앱은 안 읽지만, 되돌리면 옛 이미지가 읽는다.

푸시 전에 서버에서 DB 가 보이는지 먼저 확인해두면 배포가 마이그레이션에서 멈출 일이 없다:

```bash
ssh ubuntu@<앱 서버 IP>
docker run --rm -it mysql:8.4 mysql -h <HeatWave 사설 IP> -u travel_app -p travel -e "select count(*) from users"
```

## 6. push → 배포

```bash
git push origin main
```

배포 로그에서 이 순서를 본다:

```
▸ 시크릿 → .env
  MYSQL_HOST: 갱신
  ...
▸ 이미지 받기 & 교체
▸ 스키마 마이그레이션
▸ 마이그레이션 — 새로 적용할 것 없음
▸ 기동
▸ 헬스체크
  앱 정상
  DB: ok
```

마이그레이션이 실패하면 배포가 거기서 멈추고 **돌던 컨테이너(Supabase 버전)는 그대로 산다.**
고치고 다시 push 하면 된다.

## 7. 데이터 복사 (2차)

4단계와 6단계 사이에 Supabase 에 들어간 행(새 사용자·메시지·노출)을 따라잡는다. 4단계와 같은 명령이다.

```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=travel_app MYSQL_PASSWORD='...' MYSQL_DATABASE=travel \
  npm run db:copy-from-supabase
```

> ⚠️ **넣기만 하므로 이미 옮긴 행의 변경은 안 따라온다.** 4~6 사이에 눌린 클릭의 `click_count` 증가,
> 관리 화면에서 고친 관광지 정보가 그렇다. 몇 분 사이의 집계 몇 칸이라 무시해도 되지만,
> 관광지를 그 사이에 고쳤다면 MySQL 쪽에서 다시 고친다.

이제 `--check` 로 맞는지만 볼 수 있다. Supabase 에는 더 이상 아무도 안 쓰므로 전부 일치해야 한다:

```bash
... npm run db:copy-from-supabase -- --check
# ▸ 전 테이블 행 수 일치
```

## 8. 확인

```bash
curl -s https://bot.nolmoa.com/health | jq .db        # "mysql"
curl -s https://bot.nolmoa.com/health/db | jq          # status ok, latencyMs 가 한 자리~두 자리
```

- 카카오톡에서 호텔·관광지를 한 번씩 물어보고, 예전에 받았던 카드의 링크를 하나 눌러본다(옛 `clickId` 가 MySQL 에 있는지)
- `messages` · `recommendation_items` 에 새 행이 쌓이는지

### 다 끝나면

- 서버·로컬 `.env` 에서 `SUPABASE_*` 지우기
- Supabase 프로젝트는 며칠 두고 보다가 정지(일시정지 → 삭제)
- 부하 시험 다시 — [LOADTEST.md](LOADTEST.md) 의 "DB 왕복이 천장" 결론이 바뀌었는지 본다
- 이 문서·`scripts/copy-from-supabase.ts`·`supabase/migrations/`·package.json 의 `db:copy-from-supabase` 지우기

---

## 되돌리기

6단계 뒤에 문제가 생기면 직전 이미지로 돌린다 — Supabase 는 그대로 있다:

```bash
cd /opt/gajago
echo <PAT(read:packages)> | docker login ghcr.io -u <github 아이디> --password-stdin
IMAGE_TAG=<MySQL 전환 직전 커밋 SHA 전체> bash deploy/remote.sh
docker logout ghcr.io
```

옛 이미지에는 마이그레이션 러너가 없으므로 배포 스크립트가 그 단계를 건너뛴다.
옛 이미지는 `SUPABASE_*` 를 읽으니 **그 값이 서버 `.env` 에 남아 있어야 한다** (5단계에서 지우지 말라고 한 이유).

단 **그 사이 MySQL 에 쌓인 행은 Supabase 로 안 돌아간다.** 되돌릴 거면 빨리 정한다.

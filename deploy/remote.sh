#!/usr/bin/env bash
# 서버에서 실행되는 배포 스크립트.
# GitHub Actions 가 SSH 로 이 파일을 통째로 넘겨 실행한다 (.github/workflows/deploy.yml).
# 수동 배포도 같은 스크립트를 쓴다:  bash deploy/remote.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/travel-chatbot-app}"
cd "$APP_DIR"

# 배포가 겹치면 안 된다.
#
# 워크플로의 concurrency 는 **GitHub Actions 끼리만** 직렬화한다. CI 배포가 도는 중에
# 서버에서 손으로 이 스크립트를 돌리면 `docker compose up` 두 개가 같은 컨테이너를
# 동시에 재생성하려다 이름 충돌로 둘 다 죽는다. 실제로 그렇게 앱이 잠시 내려간 적 있다.
#
# 200 은 "다른 배포가 돌고 있다"는 뜻의 자체 종료 코드다.
exec 9>"$APP_DIR/.deploy.lock"
if ! flock -n 9; then
    echo "다른 배포가 진행 중입니다. 끝난 뒤 다시 실행하세요."
    exit 200
fi

echo "▸ 코드 갱신"
git fetch --prune origin
# 서버는 읽기 전용으로 취급한다. 서버에서 직접 고친 추적 파일은 버린다.
# .env 는 추적 대상이 아니라서 그대로 남는다.
git reset --hard origin/main
git log --oneline -1

echo "▸ 빌드 & 기동"
docker compose up -d --build --remove-orphans

echo "▸ 헬스체크"
# 도메인·DNS 와 무관하게 컨테이너 안에서 직접 확인한다.
for i in $(seq 1 30); do
    if docker compose exec -T app node -e "
fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))
" 2>/dev/null; then
        echo "  앱 정상 (${i}회차)"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "  헬스체크 실패. 로그:"
        docker compose logs --tail=50 app
        exit 1
    fi
    sleep 2
done

# DB 는 붙었는지만 알려주고 실패해도 배포를 되돌리지는 않는다.
# Supabase 가 잠깐 흔들렸다고 배포가 실패로 뜨면 안 된다.
docker compose exec -T app node -e "
fetch('http://127.0.0.1:8000/health/db')
  .then(async (r) => {
    const b = await r.json();
    console.log('  DB:', b.status, b.hint ? '- ' + b.hint : '');
  })
  .catch((e) => console.log('  DB: 확인 실패 -', e.message));
" || true

echo "▸ 오래된 이미지 정리"
docker image prune -f >/dev/null

echo "배포 완료"

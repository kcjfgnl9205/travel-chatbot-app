#!/usr/bin/env bash
# 서버에서 실행되는 배포 스크립트.
# GitHub Actions 가 SSH 로 접속해 실행한다 (.github/workflows/deploy.yml).
#
#   IMAGE_TAG=<커밋SHA> bash deploy/remote.sh   레지스트리 이미지를 받아 교체 (CI)
#   bash deploy/remote.sh                       서버에서 빌드 (손으로, 느리다)
#
# 되돌리기도 첫 줄로 한다 — 예전 커밋 SHA 를 넣으면 그 이미지로 돌아간다.
# 받으려면 먼저 `docker login ghcr.io` 가 되어 있어야 한다 (CI 는 알아서 한다).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/gajago}"
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

IMAGE="ghcr.io/kcjfgnl9205/travel-chatbot-app"

if [ -n "${IMAGE_TAG:-}" ]; then
    echo "▸ 이미지 받기 & 교체 (${IMAGE_TAG})"
    # 서버에서는 빌드하지 않는다. NCP 로 옮긴 뒤 여기서 굽던 빌드가 10분을 넘겼다.
    export IMAGE_TAG
    docker compose pull app
    docker compose up -d --no-build --remove-orphans
else
    echo "▸ 빌드 & 기동 (테스트 ${SKIP_TESTS:+생략}${SKIP_TESTS:-포함})"
    # 손으로 돌릴 때의 길이다. 빌드 안에서 테스트가 같이 돌아 깨진 커밋을 막는다.
    # 느린 서버라 수 분이 걸린다. 급하면 SKIP_TESTS=1.
    docker compose up -d --build --remove-orphans
fi

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
# 받은 이미지는 SHA 태그라 dangling 이 아니어서 위에서 안 지워진다. 지금 쓰는 것과
# 직전 것 하나만 남긴다 — 직전 것은 되돌릴 때 다시 받지 않아도 되게.
if [ -n "${IMAGE_TAG:-}" ]; then
    docker images "$IMAGE" --format '{{.Tag}}' \
        | grep -vx -e "$IMAGE_TAG" -e local \
        | tail -n +2 \
        | xargs -r -I{} docker rmi "$IMAGE:{}" >/dev/null 2>&1 || true
fi

echo "배포 완료"

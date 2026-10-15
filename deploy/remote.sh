#!/usr/bin/env bash
# 서버에서 실행되는 배포 스크립트.
# GitHub Actions 가 SSH 로 접속해 실행한다 (.github/workflows/deploy.yml).
#
#   IMAGE_TAG=<커밋SHA> bash deploy/remote.sh   레지스트리 이미지를 받아 교체 (CI)
#   bash deploy/remote.sh                       서버에서 빌드 (손으로, 느리다)
#
# 되돌리기도 첫 줄로 한다 — 예전 커밋 SHA 를 넣으면 그 이미지로 돌아가고,
# **저장소도 그 커밋으로 맞춘다**(아래 '코드 갱신' 참고).
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

# ⚠️ **되돌릴 때는 코드도 그 커밋으로 맞춘다.**
#    옛 이미지를 받으면서 저장소만 최신으로 두면 **이미지는 과거, compose·nginx·
#    마이그레이션은 현재**인 조합이 된다. `git log -1` 도 돌고 있지 않은 커밋을
#    가리켜서, 무엇이 서빙 중인지 아무도 모르게 된다.
#
#    CI 경로는 IMAGE_TAG 가 곧 origin/main 이라 아래 else 로 간다 — 동작이 같다.
if [ -n "${IMAGE_TAG:-}" ] \
    && git rev-parse --verify --quiet "${IMAGE_TAG}^{commit}" >/dev/null \
    && [ "$(git rev-parse "${IMAGE_TAG}^{commit}")" != "$(git rev-parse origin/main)" ]; then
    echo "  되돌리기 — 저장소도 ${IMAGE_TAG} 로 맞춘다"
    git -c advice.detachedHead=false checkout --force --detach "$IMAGE_TAG"
else
    # 서버는 읽기 전용으로 취급한다. 서버에서 직접 고친 추적 파일은 버린다.
    # .env 는 추적 대상이 아니라서 그대로 남는다.
    # (되돌린 뒤 다시 배포하면 여기서 main 으로 돌아온다)
    git checkout --force -B main origin/main
fi
git log --oneline -1

IMAGE="ghcr.io/kcjfgnl9205/travel-chatbot-app"

# ⚠️ **갈아끼우기 전에 지금 돌고 있는 이미지를 적어둔다.**
#    헬스체크가 실패하면 여기로 되돌린다. 예전에는 서버에서 빌드해서 깨진 커밋이
#    이미지조차 못 만들었고 돌던 컨테이너가 그대로 살아 있었는데, 지금은 **이미지를
#    받아 컨테이너를 교체한 뒤** 부팅에 실패한다. 그러면 서비스가 내려간 채로 끝난다.
previous_image="$(docker compose ps -q app 2>/dev/null | head -1 \
    | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true)"

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

# 도메인·DNS 와 무관하게 컨테이너 안에서 직접 확인한다.
wait_healthy() {
    local tries="${1:-30}"
    for i in $(seq 1 "$tries"); do
        if docker compose exec -T app node -e "
fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))
" 2>/dev/null; then
            echo "  앱 정상 (${i}회차)"
            return 0
        fi
        sleep 2
    done
    return 1
}

# 직전 이미지로 되돌린다. **배포 실패를 서비스 중단으로 만들지 않기 위한 장치다.**
rollback() {
    if [ -z "$previous_image" ]; then
        echo "  되돌릴 직전 이미지가 없다 (첫 배포이거나 컨테이너가 없었다)."
        return 1
    fi
    if [ "$previous_image" = "${IMAGE}:${IMAGE_TAG:-local}" ]; then
        echo "  직전 이미지가 방금 올린 것과 같다. 되돌릴 곳이 없다."
        return 1
    fi
    echo "  직전 이미지로 되돌린다: ${previous_image}"
    IMAGE_TAG="${previous_image##*:}" docker compose up -d --no-build --remove-orphans
}

echo "▸ 헬스체크"
if ! wait_healthy 30; then
    echo "  헬스체크 실패. 로그:"
    docker compose logs --tail=50 app
    if rollback; then
        if wait_healthy 15; then
            echo "  되돌렸다 — 서비스는 직전 버전으로 돌아갔다."
        else
            echo "  ⚠️ 되돌린 뒤에도 안 뜬다. 서버를 직접 봐야 한다."
        fi
    fi
    exit 1
fi

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

# ⚠️ **nginx 는 이 스크립트가 건드리지 않는다.** 저장소의 설정을 고쳐 배포해도
#    서버에 복사하지 않으면 아무 일도 일어나지 않는다 — 실제로 "점검 중" 폴백을
#    넣고도 한동안 적용이 안 된 적이 있다. 그래서 **다르면 말이라도 해준다.**
#    (읽기만 하므로 sudo 가 필요 없다)
echo "▸ nginx 설정 확인"
for conf in deploy/nginx/*.conf; do
    [ -e "$conf" ] || continue
    installed="/etc/nginx/sites-available/$(basename "$conf")"
    if [ ! -e "$installed" ]; then
        echo "  (건너뜀) ${installed} 없음 — 이 서버가 안 쓰거나 이름이 다르다"
    elif ! diff -q "$conf" "$installed" >/dev/null 2>&1; then
        echo "  ⚠️ ${installed} 가 저장소와 다르다. 반영하려면:"
        echo "     sudo cp ${APP_DIR}/${conf} /etc/nginx/sites-available/ \\"
        echo "       && sudo nginx -t && sudo systemctl reload nginx"
    fi
done

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

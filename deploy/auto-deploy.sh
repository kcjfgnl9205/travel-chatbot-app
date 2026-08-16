#!/usr/bin/env bash
# 서버가 스스로 origin/main 을 확인하고, 새 커밋이 있을 때만 배포한다.
# systemd 타이머가 1분마다 호출한다 (deploy/systemd/ 참고).
#
# GitHub Actions 를 쓰지 않는 이유로 생기는 이점
#   · SSH 개인키를 GitHub 에 두지 않아도 된다 (유출 지점이 하나 줄어든다)
#   · 서버에 인바운드 포트를 열 필요가 없다 (바깥 → 안 방향 연결이 없다)
#   · GitHub 이 죽어도 배포 경로만 멈출 뿐 서비스는 그대로다
#
# 대가: push 후 반영까지 최대 1분 걸린다.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/travel-chatbot-app}"
cd "$APP_DIR"

git fetch --prune --quiet origin

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0   # 변경 없음. 조용히 끝낸다 (1분마다 도는 로그를 더럽히지 않는다)
fi

echo "새 커밋 감지: ${LOCAL:0:7} → ${REMOTE:0:7}"
exec bash "$APP_DIR/deploy/remote.sh"

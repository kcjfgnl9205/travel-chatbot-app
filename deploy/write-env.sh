#!/usr/bin/env bash
# GitHub Secrets 로 받은 값을 서버 .env 에 써 넣는다 (.github/workflows/deploy.yml 이 부른다).
#
#   bash deploy/write-env.sh .env MYSQL_HOST MYSQL_USER ...
#
# 인자로 받은 **이름**의 환경변수를 읽어, .env 의 같은 줄을 바꾸거나 없으면 덧붙인다.
# 나머지 줄은 건드리지 않는다 — 다른 시크릿(OpenAI·애드픽)은 계속 서버 .env 에 있다.
#
# 왜 컨테이너에 바로 넘기지 않고 파일에 쓰는가:
#   서버에서 손으로 배포하거나(`bash deploy/remote.sh`) 되돌릴 때 GitHub 은 없다.
#   그때도 같은 값으로 떠야 하므로 .env 가 마지막으로 받은 값을 들고 있어야 한다.
#
# ⚠️ **비어 있으면 서버 값을 그대로 둔다.** 시크릿 등록을 깜빡한 배포가 운영 DB 접속
#    정보를 지워버리면 안 된다.
# ⚠️ **값을 로그에 찍지 않는다.** 이름과 "갱신/유지" 만 남긴다.
set -euo pipefail

file="$1"
shift

touch "$file"
chmod 600 "$file"

for key in "$@"; do
    value="${!key:-}"
    if [ -z "$value" ]; then
        echo "  ${key}: 시크릿 없음 — 서버 값 유지"
        continue
    fi
    # 작은따옴표로 감싸 그대로 넣는다($·#·공백이 해석되지 않게). 그래서 값 안의
    # 작은따옴표와 줄바꿈은 담을 수 없다 — 조용히 깨진 값을 쓰느니 멈춘다.
    case "$value" in
        *"'"* | *$'\n'*)
            echo "  ⚠️ ${key} 에 작은따옴표나 줄바꿈이 있다. .env 에 안전하게 못 쓴다 — 값을 바꿔라."
            exit 1
            ;;
    esac

    tmp="$(mktemp)"
    grep -v "^${key}=" "$file" > "$tmp" || true
    printf "%s='%s'\n" "$key" "$value" >> "$tmp"
    # mv 가 아니라 cat > 로 덮는다. 원래 파일의 소유자·권한(600)을 그대로 두려고.
    cat "$tmp" > "$file"
    rm -f "$tmp"
    echo "  ${key}: 갱신"
done

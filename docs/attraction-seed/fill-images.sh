#!/usr/bin/env bash
# 모든 도시의 빈 사진을 위키미디어에서 채운다.
#
# 모델을 안 부른다. 위키미디어 API 는 키가 필요 없고 무료다 —
# X-Debug-Token 은 운영자 확인용 비밀번호일 뿐 유료 키가 아니다.
#
#   BASE=https://bot.nolmoa.com DEBUG_TOKEN=xxx ./fill-images.sh
#
# ⚠️ 느리다. 빈 곳 하나당 최대 3회 조회(ko → en → commons)라
#    116곳이면 수십 분이 걸린다. 중간에 끊어도 안전하다 —
#    이미 채워진 칸은 건너뛰므로 다시 돌리면 남은 것만 채운다.
set -u
BASE="${BASE:-http://localhost:8000}"
: "${DEBUG_TOKEN:?DEBUG_TOKEN 이 필요하다}"

# ⚠️ **도시 사이에 쉬는 게 이 스크립트의 핵심이다.**
#
# 서버는 한 도시의 빈 곳을 Promise.all 로 **동시에** 찾는다 — 20곳짜리 도시면
# ko→en→commons 까지 최대 60요청이 한 번에 터진다. 쉬지 않고 116곳을 돌렸더니
# 31곳쯤에서 위키미디어가 429 를 돌려주기 시작했고, 그 거절이 전부 "사진 없음"
# 으로 기록됐다(1,290건 중 1,048건). 서버가 실패와 없음을 구별하지 않기 때문이다
# — attraction-image.ts 의 `if (!res.ok) return []` 과 `catch { return [] }`.
#
# ko.wikipedia.org 에 직접 재서 정한 값이다 (2026-10-04):
#
#   쉬지 않고 60 동시 × 4회   누적 120 에서 429 시작, 180 부터 전멸
#   20초 간격 60 동시 × 4회   누적 240 까지 **429 0건**
#   완전히 막힌 뒤 회복        10초
#
# 20 이 측정으로 확인된 하한이다. 더 내리려면 다시 재라.
SLEEP="${SLEEP:-20}"

cd "$(dirname "$0")"

# 한 도시만 보려면: ./fill-images.sh 오사카
if [ $# -gt 0 ]; then
    printf '%s / %s\n' "$1" "$1" > /tmp/one-city.txt
    LIST=/tmp/one-city.txt
else
    LIST=cities.txt
fi

i=0
total=$(grep -c . "$LIST")
while IFS= read -r line; do
    city="${line#*/ }"
    [ -z "$city" ] && continue
    i=$((i + 1))
    printf '[%3d/%d] %-14s ' "$i" "$total" "$city"
    # ⚠️ --max-time 이 없으면 한 도시가 멎을 때 루프가 영영 안 끝난다.
    #    도시 안에서는 동시 조회라 수십 초면 끝난다. 300초면 넉넉하다.
    if ! curl -sS --max-time 300 -w ' [HTTP %{http_code}]' \
              -X POST "$BASE/api/v1/admin/attractions/images" \
              -H "X-Debug-Token: $DEBUG_TOKEN" \
              -H 'Content-Type: application/json' \
              -d "{\"city\":\"$city\"}"; then
        echo -n ' <- 실패. 이 도시는 나중에 다시 돌려라'
    fi
    echo
    [ "$i" -lt "$total" ] && sleep "$SLEEP"
done < "$LIST"

echo
echo "끝. filled=0 인 도시가 많이 남았으면 그대로 한 번 더 돌려라 —"
echo "이미 채워진 칸은 건너뛰므로 실패한 것만 다시 간다. SLEEP 를 올려도 된다."

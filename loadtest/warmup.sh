#!/usr/bin/env bash
# 부하 단계에서 쓸 도시들의 검색 결과를 **미리 채운다.**
#
# 왜 필요한가: 캐시가 비어 있으면 첫 요청마다 OpenAI 웹 검색이 돈다(20~30초, 유료).
# 그 상태로 부하를 주면 측정되는 건 서버 용량이 아니라 OpenAI 대기열이고, 비용도
# 요청 수만큼 나간다. 워밍업은 **도시당 한 번만** 그 값을 치른다.
#
# 발화는 사전에서 끝나는 문형("오사카 호텔 추천해줘")이라 의도 해석에는 모델이
# 안 붙는다. 즉 여기서 드는 비용은 도시별 호텔 검색 1회뿐이다.
#
#   ./loadtest/warmup.sh
#   BASE=http://127.0.0.1:8000 ./loadtest/warmup.sh
#
# ⚠️ macOS 기본 bash 3.2 에서도 돌아야 한다 — 연관배열(declare -A)을 쓰지 않는다.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-https://bot.nolmoa.com}"
TOKEN="${TOKEN:-$(grep -E '^KAKAO_SKILL_TOKEN=' .env 2>/dev/null | cut -d= -f2-)}"
CITIES="${CITIES:-오사카,도쿄,다낭,방콕,후쿠오카,나트랑,타이페이,세부,하노이,싱가포르}"
ROUNDS="${ROUNDS:-8}"      # 미스면 몇 번까지 다시 물어볼지
GAP="${GAP:-25}"           # 라운드 사이 대기(초). 백그라운드 검색이 20~30초다

ask() { # $1=발화  $2=사용자키
  curl -s -m 25 -X POST "$BASE/api/v1/kakao/router" \
    -H 'Content-Type: application/json' \
    ${TOKEN:+-H "X-Skill-Token: $TOKEN"} \
    -d "$(printf '{"userRequest":{"utterance":"%s","user":{"id":"%s"}},"bot":{"name":"가자고"},"action":{"clientExtra":{}}}' "$1" "$2")"
}

IFS=',' read -ra LIST <<< "$CITIES"
DONE=""   # " 도시 도시 " 형태. bash 3.2 라 연관배열 대신 문자열로 센다.
total=${#LIST[@]}

echo "▸ 워밍업 대상 ${total}개 · $BASE"
for round in $(seq 1 "$ROUNDS"); do
  pending=0
  for city in "${LIST[@]}"; do
    case "$DONE" in *" $city "*) continue ;; esac
    body=$(ask "${city} 호텔 추천해줘" "warmup-${city}")
    if printf '%s' "$body" | grep -q 'listCard'; then
      DONE="$DONE $city "
      echo "  ✓ ${city}"
    else
      pending=$((pending+1))
      case "$body" in
        *"먼저 찾고 있어요"*) state="다른 요청이 검색중" ;;
        *"찾고 있어요"*)      state="검색중" ;;
        *"이해하지 못했어요"*) state="도움말 (⚠️ 예산초과 의심)" ;;
        *"점검 중"*)          state="⚠️ 앱 다운 (nginx 폴백)" ;;
        *"불러오지 못했어요"*) state="검색 실패" ;;
        *"어느 도시"*)        state="나라로 해석됨 — 도시명을 바꿔라" ;;
        *)                    state="$(printf '%s' "$body" | head -c 60)" ;;
      esac
      echo "  · ${city} — ${state}"
    fi
  done
  [ "$pending" -eq 0 ] && break
  if [ "$round" -lt "$ROUNDS" ]; then
    echo "▸ ${round}회차 끝: ${pending}개 남음. ${GAP}초 대기"
    sleep "$GAP"
  fi
done

READY_LIST="$(printf '%s' "$DONE" | tr -s ' ' '\n' | grep -v '^$' | paste -sd, -)"
ready=$(printf '%s' "$READY_LIST" | awk -F, '{print ($0=="")?0:NF}')
echo "▸ 준비됨 ${ready}/${total}"
# 부하 단계에 그대로 넘길 수 있게, 성공한 도시만 콤마로 출력한다.
printf '▸ CITIES=%s\n' "$READY_LIST"
[ "$ready" -lt "$total" ] && echo "  (못 채운 도시는 CITIES 에서 빼고 부하를 돌리는 편이 깨끗하다)"
exit 0

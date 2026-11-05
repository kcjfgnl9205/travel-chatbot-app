#!/usr/bin/env bash
# 동시 사용자를 단계적으로 올리며 **한계를 찾는다.**
#
#   ./loadtest/run.sh                       # 1→2→5→10→20→40 VU, mixed
#   STEPS="1 5 20" SCENARIO=cached ./loadtest/run.sh
#   BASE=http://127.0.0.1:8000 ./loadtest/run.sh      # 오리진 직접(서버 안에서)
#
# ⚠️ **운영 서버를 때린다.** 아래 두 조건에서 다음 단계로 올라가지 않고 멈춘다:
#      · nginx 폴백("점검 중") 이 한 번이라도 나오면 — 앱이 죽었다는 뜻
#      · 예산에서 잘린 응답이 ABORT_HELP(기본 25%) 를 넘으면 — 이미 한계를 지났다
#      · HTTP 실패가 ABORT_FAIL(기본 5%) 를 넘으면 — 요청이 앱에 닿지도 못하고 있다
#    실사용자가 같은 서버를 쓰고 있으므로, 한계를 '확인' 하면 더 밀지 않는다.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-https://bot.nolmoa.com}"
TOKEN="${TOKEN:-$(grep -E '^KAKAO_SKILL_TOKEN=' .env 2>/dev/null | cut -d= -f2-)}"
SCENARIO="${SCENARIO:-mixed}"
STEPS="${STEPS:-1 2 5 10 20 40}"
DURATION="${DURATION:-30s}"
BUDGET_MS="${BUDGET_MS:-3500}"
ABORT_HELP="${ABORT_HELP:-25}"     # 예산잘림 % 상한
# ⚠️ **이 조건이 없어서 2026-11-04 에 그냥 지나쳤다.** 동시 400 에서 HTTP 실패가
#    15.6% 였는데 중단 조건이 app_down 과 예산잘림뿐이라 500 까지 올라갔고 거기서
#    76.8% 가 됐다. 앞단(Cloudflare↔nginx TLS)이 무너지는 건 둘 중 어느 쪽에도
#    안 잡힌다 — 앱은 멀쩡하고 예산도 안 넘기 때문이다.
ABORT_FAIL="${ABORT_FAIL:-5}"      # HTTP 실패 % 상한
COOL="${COOL:-15}"                 # 단계 사이 회복 대기(초)
OUT="${OUT:-$(mktemp -d)}"

echo "▸ 대상   $BASE"
echo "▸ 단계   $STEPS VU · 각 $DURATION · scenario=$SCENARIO"
echo "▸ 중단   예산잘림>${ABORT_HELP}% · HTTP실패>${ABORT_FAIL}% · 앱다운 1회"
echo "▸ 예산   ${BUDGET_MS}ms (카카오 5초 중 앱이 스스로 끊는 지점)"
echo "▸ 결과   $OUT"
echo

rows=()
for vus in $STEPS; do
  echo "────── VU=$vus ──────"
  BASE="$BASE" TOKEN="$TOKEN" SCENARIO="$SCENARIO" VUS="$vus" DURATION="$DURATION" \
  BUDGET_MS="$BUDGET_MS" SUMMARY_OUT="$OUT/vu-$vus.json" CITIES="${CITIES:-}" \
    k6 run --quiet --no-usage-report loadtest/router.js || true

  f="$OUT/vu-$vus.json"
  [[ -f "$f" ]] || { echo "  (요약 파일 없음 — 중단)"; break; }

  read -r rps p50 p95 over help down fail < <(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).metrics;
    const v=(m,k)=>(d[m]&&typeof d[m].values[k]==="number")?d[m].values[k]:0;
    console.log([v("http_reqs","rate").toFixed(1),v("http_req_duration","med").toFixed(0),
      v("http_req_duration","p(95)").toFixed(0),(v("over_budget","rate")*100).toFixed(1),
      (v("budget_cut","rate")*100).toFixed(1),v("kakao_app_down","count"),
      (v("http_req_failed","rate")*100).toFixed(1)].join(" "));
  ' "$f")

  rows+=("$vus|$rps|$p50|$p95|$over|$help|$down|$fail")

  if [[ "${down%.*}" -gt 0 ]]; then
    echo "  ⛔ nginx 폴백 발생 — 앱이 요청을 못 받았다. 여기서 멈춘다."
    break
  fi
  if (( $(echo "$help > $ABORT_HELP" | bc -l) )); then
    echo "  ⛔ 예산잘림 ${help}% > ${ABORT_HELP}% — 한계를 지났다. 여기서 멈춘다."
    break
  fi
  if (( $(echo "$fail > $ABORT_FAIL" | bc -l) )); then
    echo "  ⛔ HTTP 실패 ${fail}% > ${ABORT_FAIL}% — 요청이 앱에 닿지 못하고 있다."
    echo "     (Cloudflare 525/502 라면 범인은 앱이 아니라 nginx·TLS 쪽이다)"
    break
  fi
  echo "  ${COOL}초 회복 대기"
  sleep "$COOL"
done

if [ "${#rows[@]}" -eq 0 ]; then
  echo; echo "⛔ 한 단계도 완주하지 못했다. 위의 k6 출력을 볼 것."; exit 1
fi

echo
echo "╔══════════════════════════════════════════════════════════════════════════╗"
printf "║ %-4s %8s %8s %8s %10s %10s %7s %7s ║\n" VU "req/s" "p50" "p95" "예산초과" "예산잘림" "앱다운" "HTTP실패"
echo "╠══════════════════════════════════════════════════════════════════════════╣"
for r in ${rows[@]+"${rows[@]}"}; do
  IFS='|' read -r vus rps p50 p95 over help down fail <<< "$r"
  mark=" "
  (( $(echo "$p95 > $BUDGET_MS" | bc -l) )) && mark="⚠"
  [[ "${down%.*}" -gt 0 ]] && mark="⛔"
  printf "║%s%-4s %8s %7sms %7sms %9s%% %9s%% %7s %6s%% ║\n" "$mark" "$vus" "$rps" "$p50" "$p95" "$over" "$help" "$down" "$fail"
done
echo "╚══════════════════════════════════════════════════════════════════════════╝"
echo "  ⚠ = p95 가 ${BUDGET_MS}ms 예산을 넘음 (사용자는 도움말 카드를 본다)"
echo "  원본 요약: $OUT"

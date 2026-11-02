/**
 * 카카오 스킬 라우터 부하 시험.
 *
 * **이 서비스에서 "못 버틴다" 는 500 이 아니다.** 카카오는 5초를 넘긴 응답을 버리고,
 * 그 전에 앱이 스스로 KAKAO_RESPONSE_BUDGET_SECONDS(기본 3.5초)에서 끊어 도움말
 * 카드를 보낸다. 사용자 화면에는 오류가 아니라 "이해하지 못했어요" 가 뜬다 —
 * HTTP 상태코드만 보면 100% 정상으로 보이는 고장이다.
 *
 * 그래서 여기서는 상태코드가 아니라 **응답 본문을 분류한다.**
 *
 *   카드        정상. 저장된 결과가 나갔다
 *   도움말      의도 불명(정상) 이거나 ⚠️ 예산 초과. 응답시간으로 가른다 — budget_cut
 *   검색시작    캐시 미스 — 백그라운드 검색이 돌기 시작했다
 *   먼저조회중  같은 키를 다른 요청이 선점했다 (부하에서는 정상)
 *   점검중      ⚠️⚠️ nginx 폴백. 앱에 아예 못 붙었다는 뜻이다
 *
 * SCENARIO
 *   nontravel  "안녕" — 여행 무관. AI 0회, DB 는 사용자 등록 1회. **바닥값**
 *   cached     "오사카 호텔 추천해줘" — 사전 해석(AI 0회) + 저장된 결과. **주력**
 *   more       "더 보기" 커서 — AI 0회, DB 읽기만. **가장 싼 경로**
 *   mixed      위 셋을 7:1:2 로 섞는다 (기본값)
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'https://bot.nolmoa.com';
const TOKEN = __ENV.TOKEN || '';
const SCENARIO = __ENV.SCENARIO || 'mixed';
const BUDGET_MS = Number(__ENV.BUDGET_MS || 3500);
const VUS = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || '30s';

/** 사전에 있는 도시 + 사전에서 끝나는 문형 = 모델 호출 0회. 워밍업 대상과 같아야 한다. */
const CITIES = (__ENV.CITIES || '오사카,도쿄,다낭,방콕,후쿠오카,나트랑,타이페이,세부,하노이,싱가포르').split(',');

const card = new Rate('kakao_card');            // 카드가 나간 비율
const helpFallback = new Rate("kakao_help");    // 도움말 (비여행 발화면 이게 정상이다)
const budgetCut = new Rate("budget_cut");       // ⚠️ 예산에서 잘린 도움말 = 진짜 고장
const searching = new Rate('kakao_searching');  // 캐시 미스
const busy = new Rate('kakao_busy');            // 선점됨
const appDown = new Counter('kakao_app_down');  // ⚠️ nginx 폴백
const overBudget = new Rate('over_budget');     // 예산 초과 응답시간
const cardLatency = new Trend('card_latency', true);

export const options = {
  vus: VUS,
  duration: DURATION,
  // 커넥션 재사용. 카카오도 keep-alive 로 붙는다.
  noConnectionReuse: false,
  thresholds: {
    // 깨져도 멈추지 않는다 — 어디서 깨지는지 보는 게 목적이다.
    'kakao_app_down': ['count==0'],
    "budget_cut": ["rate<0.05"],
    'http_req_duration': [`p(95)<${BUDGET_MS}`],
  },
};

function payload(utterance, userId, clientExtra) {
  return JSON.stringify({
    intent: { id: 'loadtest', name: '폴백 블록' },
    userRequest: {
      timezone: 'Asia/Seoul',
      params: {},
      block: { id: 'loadtest-block', name: '폴백 블록' },
      utterance,
      lang: 'kr',
      user: { id: userId, type: 'botUserKey', properties: { botUserKey: userId } },
    },
    bot: { id: 'loadtest-bot', name: '가자고' },
    action: { name: '폴백액션', clientExtra: clientExtra || {}, params: {}, detailParams: {}, id: 'loadtest-action' },
  });
}

const params = {
  headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Skill-Token': TOKEN } : {}) },
  timeout: '20s',
  tags: { endpoint: 'router' },
};

/** 본문으로 무엇이 나갔는지 가린다. 순서가 중요하다 — "먼저 찾고 있어요" 가 "찾고 있어요" 를 포함한다. */
function classify(body) {
  if (!body) return 'empty';
  if (body.includes('점검 중')) return 'app_down';
  if (body.includes('listCard')) return 'card';
  if (body.includes('먼저 찾고 있어요')) return 'busy';
  if (body.includes('찾고 있어요')) return 'searching';
  if (body.includes('이해하지 못했어요')) return 'help';
  if (body.includes('불러오지 못했어요')) return 'failed';
  if (body.includes('어느 도시')) return 'ask_city';
  return 'other';
}

function record(res) {
  const kind = classify(res.body);
  card.add(kind === 'card');
  helpFallback.add(kind === "help");
  // ⚠️ 도움말은 두 가지다. "안녕" 에 대한 정상 응답은 240ms 에 나오고,
  //    예산에서 잘린 것은 반드시 예산 근처까지 끌다 나온다. 후자만 고장이다.
  budgetCut.add(kind === "help" && res.timings.duration >= BUDGET_MS * 0.9);
  searching.add(kind === 'searching');
  busy.add(kind === 'busy');
  if (kind === 'app_down') appDown.add(1);
  overBudget.add(res.timings.duration > BUDGET_MS);
  if (kind === 'card') cardLatency.add(res.timings.duration);

  check(res, {
    'HTTP 2xx': (r) => r.status >= 200 && r.status < 300,
    '앱이 살아있다 (nginx 폴백 아님)': () => kind !== 'app_down',
    [`예산 ${BUDGET_MS}ms 안`]: (r) => r.timings.duration <= BUDGET_MS,
  });
  return kind;
}

/** 카드 응답에서 "더 보기" 커서를 꺼낸다. 없으면 null. */
function cursorOf(body) {
  const m = /"extra"\s*:\s*\{[^}]*"cache_key"\s*:\s*"([^"]+)"[^}]*"offset"\s*:\s*(\d+)/.exec(body || '');
  return m ? { cache_key: m[1], offset: Number(m[2]) } : null;
}

export default function () {
  const userId = `loadtest-${__VU}`;
  const city = CITIES[(__ITER + __VU) % CITIES.length];
  const roll = SCENARIO === 'mixed' ? (__ITER * 7 + __VU) % 10 : -1;

  let mode = SCENARIO;
  if (SCENARIO === 'mixed') mode = roll < 7 ? 'cached' : roll < 8 ? 'more' : 'nontravel';

  if (mode === 'nontravel') {
    record(http.post(`${BASE}/api/v1/kakao/router`, payload('안녕하세요', userId), params));
    return;
  }

  const res = http.post(`${BASE}/api/v1/kakao/router`, payload(`${city} 호텔 추천해줘`, userId), params);
  const kind = record(res);

  // "더 보기" 는 카드를 받은 직후에만 의미가 있다 (커서가 카드에 실려 온다).
  if (mode === 'more' && kind === 'card') {
    const cursor = cursorOf(res.body);
    if (cursor) record(http.post(`${BASE}/api/v1/kakao/router`, payload(`${city} 호텔 더 보기`, userId, cursor), params));
  }
}

export function handleSummary(data) {
  const out = __ENV.SUMMARY_OUT;
  const res = { stdout: textSummary(data) };
  if (out) res[out] = JSON.stringify(data, null, 2);
  return res;
}

function pct(metric, key) {
  const v = metric && metric.values ? metric.values[key] : undefined;
  return typeof v === 'number' ? v : NaN;
}

function textSummary(data) {
  const m = data.metrics;
  const n = pct(m.http_reqs, 'count');
  const line = (label, value) => `  ${label.padEnd(26)} ${value}\n`;
  const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(0)}ms` : '—');
  const rate = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

  return (
    `\n━━ VU=${VUS} ${DURATION} scenario=${SCENARIO} ━━\n` +
    line('요청', `${n} (${pct(m.http_reqs, 'rate').toFixed(1)}/s)`) +
    line('응답 p50 / p95 / max', `${ms(pct(m.http_req_duration, 'med'))} / ${ms(pct(m.http_req_duration, 'p(95)'))} / ${ms(pct(m.http_req_duration, 'max'))}`) +
    line(`예산(${BUDGET_MS}ms) 초과`, rate(pct(m.over_budget, 'rate'))) +
    line('카드 정상', rate(pct(m.kakao_card, 'rate'))) +
    line("도움말 (정상+잘림)", rate(pct(m.kakao_help, "rate"))) +
    line("⚠️ 예산에서 잘림", rate(pct(m.budget_cut, "rate"))) +
    line('검색시작(미스)', rate(pct(m.kakao_searching, 'rate'))) +
    line('먼저조회중', rate(pct(m.kakao_busy, 'rate'))) +
    line('⚠️ 앱 다운(nginx)', `${pct(m.kakao_app_down, 'count') || 0}`) +
    line('HTTP 실패', rate(pct(m.http_req_failed, 'rate'))) +
    '\n'
  );
}

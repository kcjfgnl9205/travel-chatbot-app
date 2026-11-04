/**
 * /health 만 때린다. **DB 도 AI 도 안 붙는 순수 앱 용량.**
 *
 * 라우터가 느릴 때 "앱이 느린가, 의존성이 느린가" 를 가르는 기준선이다.
 * 여기서 p95 가 멀쩡한데 라우터만 무너지면 범인은 DB/OpenAI 쪽이고,
 * 여기서부터 무너지면 1 vCPU 가 이벤트루프를 못 돌리고 있는 것이다.
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE || 'https://bot.nolmoa.com';
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';

export const options = { vus: VUS, duration: DURATION, thresholds: { http_req_failed: ['rate<0.01'] } };

export default function () {
  const res = http.get(`${BASE}/health`, { timeout: '10s', tags: { endpoint: 'health' } });
  check(res, {
    'HTTP 200': (r) => r.status === 200,
    // ⚠️ DB 이름을 박아두지 않는다. Supabase → MySQL 로 한 번 갈아타면서 이 체크가
    //    조용히 거짓이 됐다. 묻는 것은 "어떤 DB 인가" 가 아니라 "붙어 있는가" 다.
    'db 연결 유지': (r) => !/"db":"disabled/.test(r.body || ''),
  });
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (metric, key) => (m[metric] && m[metric].values[key]) || 0;
  return {
    stdout:
      `\n━━ /health VU=${VUS} ${DURATION} ━━\n` +
      `  요청        ${v('http_reqs', 'count')} (${v('http_reqs', 'rate').toFixed(1)}/s)\n` +
      `  p50/p95/max ${v('http_req_duration', 'med').toFixed(0)} / ${v('http_req_duration', 'p(95)').toFixed(0)} / ${v('http_req_duration', 'max').toFixed(0)}ms\n` +
      `  실패        ${(v('http_req_failed', 'rate') * 100).toFixed(2)}%\n\n`,
    ...(__ENV.SUMMARY_OUT ? { [__ENV.SUMMARY_OUT]: JSON.stringify(data, null, 2) } : {}),
  };
}

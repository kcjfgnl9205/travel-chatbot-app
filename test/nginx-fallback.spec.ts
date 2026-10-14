import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { simpleText } from '../src/modules/kakao/templates';

/**
 * 앱이 죽어 있을 때 **nginx 가 대신 돌려주는 말풍선**.
 *
 * ⚠️ **이게 깨지면 장애가 나기 전까지 아무도 모른다.** 평소에는 절대 안 타는 경로라서,
 *    오타 하나로 JSON 이 망가져 있어도 배포도 테스트도 통과한다. 그리고 정작 필요한
 *    순간(배포 중 재시작·프로세스 사망)에 사용자는 침묵을 받는다 — 폴백이 없는 것과
 *    똑같은 상태인데, 있다고 믿고 있으니 더 나쁘다.
 *
 * 그래서 설정 파일을 **코드가 직접 읽어서** 검사한다. nginx 를 띄우지 않고 할 수 있는
 * 검사는 여기까지다 — 문법은 서버에서 `nginx -t` 가 본다.
 */
describe('nginx 점검 중 응답', () => {
  const conf = readFileSync(
    join(__dirname, '..', 'deploy', 'nginx', 'bot-nolmoa.conf'),
    'utf8',
  );

  /** `return 200 '...'` 안의 본문. */
  const body = conf.match(/return 200 '(.+)';/)?.[1] ?? '';

  it('카카오 스킬 경로가 앱에 못 붙으면 폴백으로 간다', () => {
    expect(conf).toMatch(/location \/api\/v1\/kakao\/ \{/);
    expect(conf).toMatch(/error_page\s+502\s+503\s+504\s*=\s*@kakao_down;/);
    expect(conf).toMatch(/location @kakao_down \{/);
  });

  /**
   * ⚠️ 카카오는 2xx 가 아니면 본문을 읽지 않는다. 502 를 그대로 흘리면 침묵이다.
   */
  it('200 으로 돌려준다', () => {
    expect(conf).toMatch(/location @kakao_down \{[\s\S]*?return 200 '/);
  });

  it('앱이 내는 응답과 같은 모양이다', () => {
    const parsed = JSON.parse(body);
    const text = parsed?.template?.outputs?.[0]?.simpleText?.text;

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // 앱의 simpleText() 가 만드는 구조와 한 글자도 다르면 안 된다.
    expect(parsed).toEqual(simpleText(text));
  });

  /**
   * ⚠️ nginx 가 따옴표 안의 역슬래시를 어떻게 다루는지에 기대면, 화면에 'n' 한 글자가
   *    그대로 찍힐 수 있다. 확인할 수 없는 것에 기대지 않는다.
   */
  it('줄바꿈 이스케이프를 쓰지 않는다', () => {
    expect(body).not.toContain('\\n');
  });

  /**
   * ⚠️ `proxy_intercept_errors` 를 켜면 **앱이 스스로 낸 5xx 까지** 이 폴백이 덮는다.
   *    진짜 장애가 "점검 중이에요" 로 위장되고, /health 가 503 을 내도 감시 도구는
   *    200 을 본다. 여기 걸려야 하는 건 nginx 가 만드는 502/504 뿐이다.
   */
  it('앱이 낸 오류까지 덮지 않는다', () => {
    expect(conf).not.toMatch(/proxy_intercept_errors\s+on/);
  });
});

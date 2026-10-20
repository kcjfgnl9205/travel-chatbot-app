import { loadConfig } from '../src/config/app.config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.env.example` 이 **코드가 실제로 읽는 환경변수와 정확히 같은가.**
 *
 * ⚠️ 이걸 사람이 지키면 반드시 어긋난다. 실제로 두 번 당했다.
 *
 *   · `HOTEL_PROVIDER=static` — 아무도 안 읽는 값인데 운영 .env 에 남아 있었고,
 *     주석에는 "테스트 중 비용 절감을 위해 static 권장" 이라고 적혀 있었다.
 *     AI 를 껐다고 믿는 동안 OpenAI 요금은 그대로 나갔다.
 *   · `NLU_ALIAS_TTL_MINUTES` — 라우터 재설계로 죽었는데 문서에 남아 있었다.
 *
 * **읽지 않는 knob 은 거짓말을 한다.** 사람이 그걸 돌려보며 원인을 찾기 때문이다.
 * 반대로 코드가 읽는데 문서에 없으면, 운영에서 그 값을 조정할 수 있다는 걸 아무도
 * 모른다. 양쪽 다 여기서 막는다.
 *
 * ⚠️ **이 테스트는 저장소 파일을 직접 읽는다.** 도커 빌드가 테스트를 게이트로 쓰므로
 *    Dockerfile 이 `.env.example` 을 COPY 해야 한다. 안 하면 로컬 `npm test` 는
 *    통과하는데 배포만 깨진다 (실제로 그랬다).
 */
describe('.env.example = 코드가 읽는 환경변수', () => {
  const root = join(__dirname, '..');
  const read = (path: string) => readFileSync(join(root, path), 'utf8');

  /** loadConfig() 가 str/num/bool 로 읽는 이름 + main.ts 가 직접 읽는 이름. */
  const declared = new Set([
    ...[...read('src/config/app.config.ts').matchAll(/(?:str|num|bool)\('([A-Z_0-9]+)'/g)].map(
      (m) => m[1],
    ),
    // LOG_LEVEL·PORT 는 Nest 앱을 만들기 전에 필요해서 process.env 로 직접 읽는다.
    ...[...read('src/main.ts').matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1]),
  ]);

  const documented = new Set(
    [...read('.env.example').matchAll(/^([A-Z_0-9]+)=/gm)].map((m) => m[1]),
  );

  /**
   * ⚠️ **빈 값은 기본값이 아니다 — 였다.**
   *
   * `Number('')` 는 0 이고 0 은 유한한 수라, `FAILED_TTL_MINUTES=` 한 줄이
   * 기본값(3)이 아니라 0 으로 읽혔다. .env 에서 값을 지울 때 키까지 지우는
   * 사람은 드물어서, 빈손을 아예 안 굳히거나 타임아웃이 0 이 되는 식으로
   * 조용히 망가진다.
   */
  it('숫자 knob 은 비워둬도 기본값으로 떨어진다', () => {
    const key = 'FAILED_TTL_MINUTES';
    const original = process.env[key];
    try {
      delete process.env[key];
      const absent = loadConfig().failedTtlMinutes;

      process.env[key] = '';
      expect(loadConfig().failedTtlMinutes).toBe(absent);
      process.env[key] = '   ';
      expect(loadConfig().failedTtlMinutes).toBe(absent);
      // 값을 제대로 적으면 당연히 그 값이다.
      process.env[key] = '7';
      expect(loadConfig().failedTtlMinutes).toBe(7);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('코드가 읽는 값은 전부 문서에 있다', () => {
    expect([...declared].filter((k) => !documented.has(k)).sort()).toEqual([]);
  });

  it('문서에 있는 값은 전부 코드가 읽는다 — 죽은 knob 은 거짓말을 한다', () => {
    expect([...documented].filter((k) => !declared.has(k)).sort()).toEqual([]);
  });

  /**
   * ⚠️ **문서의 설정 표도 같은 거짓말을 한다.** `.env.example` 만 지키면 되는 줄
   *    알았는데, 실제로 둘이 샜다 — `HOTEL_THUMBNAIL_TIMEOUT_MS`(진짜 이름은
   *    `..._SECONDS`)와 `FLIGHT_PROVIDER`(환경변수가 아니라 DI 토큰이다). 표에서
   *    이름을 베껴 운영 `.env` 에 넣은 사람은 아무 일도 일어나지 않는 이유를 못 찾는다.
   *
   * 설정 표의 첫 칸(`| \`NAME\``)만 본다. 본문에서 상수 이름을 백틱으로 적는 것까지
   * 막으면 글을 못 쓴다.
   */
  it('문서의 설정 표에 적힌 환경변수도 전부 코드가 읽는다', () => {
    const docs = [
      'README.md',
      'docs/HOTEL.md',
      'docs/FLIGHT.md',
      'docs/ATTRACTION.md',
      'docs/ROUTER.md',
    ];
    const lies: string[] = [];
    for (const doc of docs) {
      for (const [, name] of read(doc).matchAll(/^\|\s*`([A-Z][A-Z_0-9]{3,})`/gm)) {
        if (!declared.has(name)) lies.push(`${doc}: ${name}`);
      }
    }
    expect(lies.sort()).toEqual([]);
  });

  it('시크릿 자리는 비어 있다 — 예시 파일이 저장소에 들어간다', () => {
    const secrets = [...read('.env.example').matchAll(/^([A-Z_0-9]*(?:KEY|TOKEN|SECRET))=(.*)$/gm)];
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.filter(([, , value]) => value.trim()).map(([, name]) => name)).toEqual([]);
  });
});

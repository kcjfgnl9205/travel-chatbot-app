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

  it('코드가 읽는 값은 전부 문서에 있다', () => {
    expect([...declared].filter((k) => !documented.has(k)).sort()).toEqual([]);
  });

  it('문서에 있는 값은 전부 코드가 읽는다 — 죽은 knob 은 거짓말을 한다', () => {
    expect([...documented].filter((k) => !declared.has(k)).sort()).toEqual([]);
  });

  it('시크릿 자리는 비어 있다 — 예시 파일이 저장소에 들어간다', () => {
    const secrets = [...read('.env.example').matchAll(/^([A-Z_0-9]*(?:KEY|TOKEN|SECRET))=(.*)$/gm)];
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.filter(([, , value]) => value.trim()).map(([, name]) => name)).toEqual([]);
  });
});

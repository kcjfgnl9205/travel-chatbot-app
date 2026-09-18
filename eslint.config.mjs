// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint 9 플랫 설정.
 *
 * ⚠️ 이 파일이 없으면 `npm run lint` 는 통과가 아니라 **에러로 끝난다.**
 *    CI([deploy.yml](.github/workflows/deploy.yml))가 lint 를 돌리지 않아서 그 사실이
 *    오래 묻혀 있었고, 그 사이 미사용 import 가 main 에 들어왔다.
 *
 * 타입 정보를 쓰는 규칙까지 켠다. 목적은 딱 하나 — **떠다니는 Promise 를 잡는 것**이다.
 * 이 코드베이스는 `void this.runSearch(...)` 처럼 백그라운드 실행을 일부러 띄우는데,
 * `void` 를 빠뜨리면 예외가 아무 데도 안 잡히고 조용히 사라진다. 타입을 모르는 린트는
 * 그걸 못 본다.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 미사용 변수는 에러. _ 로 시작하면 "일부러 안 쓴다" 는 뜻으로 봐준다.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // ---------------------------------------------------------------- 끈 것들
      // ⚠️ no-unsafe-* 계열을 끈 이유는 게을러서가 아니라 **경계 타입이 일부러 any 이기
      //    때문이다.** 카카오 응답(t.Json)·Supabase 행(Row)·모델 JSON 은 우리가 모양을
      //    정하지 않는 값이고, 그래서 unknown/any 로 받아 그 자리에서 좁혀 쓴다.
      //    켜두면 경고 150개가 전부 그 경계에서 나와 진짜 문제를 덮는다.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // `err=${err}` 는 로그의 기본 관용구다. catch 로 받은 unknown 을 String() 으로
      // 감싸는 것보다 읽기 쉽고, 로그 문자열이라 정확한 표기가 중요하지도 않다.
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',

      // async 로 선언했지만 await 가 없는 건 인터페이스 구현에서 늘 나온다
      // (SearchDomain.rows, provider.search 의 테스트 대역 등).
      '@typescript-eslint/require-await': 'off',
    },
  },
);

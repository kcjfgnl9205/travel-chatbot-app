import { textWithoutCitations } from '../src/common/parse';
import {
  ALLOWED_HOSTS,
  ALLOWED_SITES_TEXT,
  isAllowedSourceUrl,
  merchantOf,
  toKoreanUrl,
} from '../src/modules/hotel/providers/openai.provider';
import {
  FLIGHT_ALLOWED_HOSTS,
  FLIGHT_ALLOWED_SITES_TEXT,
  flightMerchantOf,
  isAllowedFlightUrl,
} from '../src/modules/flight/providers/openai.provider';
import {
  outputTextOf,
  parseJsonLoose,
  requestHeaders,
  searchCallsOf,
} from '../src/modules/openai/openai.service';
import { AppConfig, loadConfig } from '../src/config/app.config';

describe('Responses API 응답 파싱', () => {
  it('output[] 의 output_text 를 이어 붙인다', () => {
    const body = {
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: '호텔 목록' }] },
      ],
    };
    expect(outputTextOf(body)).toBe('호텔 목록');
  });

  it('SDK 가 붙여주는 output_text 가 있으면 그걸 쓴다', () => {
    expect(outputTextOf({ output_text: '바로 이거', output: [] })).toBe('바로 이거');
  });

  it('reasoning 만 있고 message 가 없으면 빈 문자열', () => {
    expect(outputTextOf({ output: [{ type: 'reasoning' }] })).toBe('');
    expect(outputTextOf(null)).toBe('');
    expect(outputTextOf({})).toBe('');
  });

  it('웹 검색을 실제로 돌았는지 센다 — 안 돌았으면 기억으로 답한 것이다', () => {
    expect(
      searchCallsOf({
        output: [
          { type: 'web_search_call' },
          { type: 'web_search_call' },
          { type: 'message', content: [] },
        ],
      }),
    ).toBe(2);
    expect(searchCallsOf({ output: [{ type: 'message' }] })).toBe(0);
  });
});

describe('느슨한 JSON 파싱', () => {
  it('순수 JSON', () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('```json 펜스를 벗긴다', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('앞뒤 설명이 붙어 와도 본문을 건진다', () => {
    expect(parseJsonLoose('결과입니다:\n{"a":1}\n감사합니다')).toEqual({ a: 1 });
  });

  it('JSON 이 아니면 null', () => {
    expect(parseJsonLoose('그냥 문장')).toBeNull();
  });
});

describe('예약 링크 검증', () => {
  it('네 곳만 통과시킨다', () => {
    expect(isAllowedSourceUrl('https://kr.trip.com/hotels/detail?id=1')).toBe(true);
    expect(isAllowedSourceUrl('https://www.myrealtrip.com/offers/12345')).toBe(true);
    expect(isAllowedSourceUrl('https://www.klook.com/ko/hotel/1-abc/')).toBe(true);
    expect(isAllowedSourceUrl('https://kr.hotels.com/ho123456/')).toBe(true);
  });

  it('빼기로 한 OTA 는 막는다', () => {
    // 프롬프트에서도 빼야 한다. 안 그러면 모델이 찾아온 걸 전부 버리게 된다.
    expect(isAllowedSourceUrl('https://www.agoda.com/ko-kr/hotel/12345.html')).toBe(false);
    expect(isAllowedSourceUrl('https://www.booking.com/hotel/jp/granvia.ko.html')).toBe(false);
    expect(isAllowedSourceUrl('https://www.expedia.co.kr/h123.Hotel-Information')).toBe(false);
  });

  it('모델이 지어낸 호스트는 막는다', () => {
    // 지어낸 URL 이 그대로 나가면 애드픽 변환을 타고 사용자에게 404 가 간다
    expect(isAllowedSourceUrl('https://hotel-booking-example.com/1')).toBe(false);
    expect(isAllowedSourceUrl('https://trip.com.evil.kr/1')).toBe(false);
    expect(isAllowedSourceUrl('https://nottrip.com/1')).toBe(false);
  });

  it('myrealtrip.com 을 trip.com 의 서브도메인으로 착각하지 않는다', () => {
    // 접미사 비교라 'myrealtrip.com'.endsWith('.trip.com') 이 걸릴 뻔한 자리다
    expect(merchantOf('https://www.myrealtrip.com/x')).toBe('myrealtrip');
    expect(merchantOf('https://kr.trip.com/x')).toBe('trip');
  });

  it('http 와 쓰레기 값은 막는다', () => {
    expect(isAllowedSourceUrl('http://kr.trip.com/1')).toBe(false);
    expect(isAllowedSourceUrl('정보 없음')).toBe(false);
    expect(isAllowedSourceUrl('')).toBe(false);
  });

  it('호스트에서 merchant 를 유추한다', () => {
    expect(merchantOf('https://www.klook.com/x')).toBe('klook');
    expect(merchantOf('https://kr.hotels.com/x')).toBe('hotels');
    expect(merchantOf('https://example.com/x')).toBeNull();
  });

  it('허용 목록은 네 곳이다', () => {
    expect(ALLOWED_HOSTS).toEqual([
      'trip.com',
      'myrealtrip.com',
      'klook.com',
      'hotels.com',
    ]);
  });

  it('프롬프트 문구와 허용 목록이 어긋나지 않는다', () => {
    // 하나만 고치고 다른 하나를 잊으면 결과가 전부 필터에 걸려 "찾지 못했어요" 가 된다
    for (const host of ALLOWED_HOSTS) {
      expect(ALLOWED_SITES_TEXT).toContain(host);
    }
  });
});

describe('요청 헤더 — 어느 프로젝트로 붙는가', () => {
  const withKeys = (over: Partial<AppConfig>): AppConfig => ({
    ...loadConfig(),
    openaiApiKey: 'sk-test',
    openaiProject: '',
    openaiOrganization: '',
    ...over,
  });

  it('기본은 인증 헤더만 보낸다', () => {
    const h = requestHeaders(withKeys({}));
    expect(h.authorization).toBe('Bearer sk-test');
    expect(h['OpenAI-Project']).toBeUndefined();
    expect(h['OpenAI-Organization']).toBeUndefined();
  });

  it('OPENAI_PROJECT 를 채우면 그 프로젝트로 붙는다', () => {
    // 이게 없으면 레거시 sk- 키가 조직 기본 프로젝트로 붙어
    // "does not have access to model" 403 이 난다.
    const h = requestHeaders(withKeys({ openaiProject: 'proj_abc123' }));
    expect(h['OpenAI-Project']).toBe('proj_abc123');
  });

  it('조직도 지정할 수 있다', () => {
    const h = requestHeaders(withKeys({ openaiOrganization: 'org_xyz' }));
    expect(h['OpenAI-Organization']).toBe('org_xyz');
  });

  it('빈 값은 헤더를 아예 안 만든다 — 빈 헤더는 거부당한다', () => {
    const h = requestHeaders(withKeys({ openaiProject: '', openaiOrganization: '' }));
    expect(Object.keys(h).sort()).toEqual(['authorization', 'content-type']);
  });
});

describe('한국어 예약 페이지로 돌린다', () => {
  it('trip.com 은 kr 서브도메인 + 한국 로케일/통화', () => {
    const out = new URL(toKoreanUrl('https://www.trip.com/hotels/osaka-hotel-detail-123/'));
    expect(out.hostname).toBe('kr.trip.com');
    expect(out.searchParams.get('locale')).toBe('ko-KR');
    expect(out.searchParams.get('curr')).toBe('KRW');
    // 경로는 그대로 — 여기를 건드리면 404 가 된다
    expect(out.pathname).toBe('/hotels/osaka-hotel-detail-123/');
  });

  it('hotels.com 은 kr 서브도메인', () => {
    expect(new URL(toKoreanUrl('https://www.hotels.com/ho123456/')).hostname).toBe(
      'kr.hotels.com',
    );
  });

  it('klook 은 로케일 구간만 ko 로 바꾼다', () => {
    expect(toKoreanUrl('https://www.klook.com/en-US/hotel/12345-abc/')).toBe(
      'https://www.klook.com/ko/hotel/12345-abc/',
    );
    expect(toKoreanUrl('https://www.klook.com/ja/hotel/12345-abc/')).toBe(
      'https://www.klook.com/ko/hotel/12345-abc/',
    );
  });

  it('klook 에 로케일 구간이 없으면 손대지 않는다 — 없는 걸 끼우다 404 를 만들지 않는다', () => {
    const url = 'https://www.klook.com/hotel/12345-abc/';
    expect(toKoreanUrl(url)).toBe(url);
  });

  it('로케일처럼 생기지 않은 첫 구간은 로케일로 오해하지 않는다', () => {
    const url = 'https://www.klook.com/hotels/osaka/';
    expect(toKoreanUrl(url)).toBe(url); // 'hotels' 는 로케일이 아니다
  });

  it('마이리얼트립은 이미 한국어라 그대로 둔다', () => {
    const url = 'https://www.myrealtrip.com/offers/98765';
    expect(toKoreanUrl(url)).toBe(url);
  });

  it('이미 한국어면 바뀌는 게 없어야 한다 (멱등)', () => {
    const once = toKoreanUrl('https://kr.trip.com/hotels/detail?id=1');
    expect(toKoreanUrl(once)).toBe(once);
  });

  it('허용 목록 밖이거나 URL 이 아니면 그대로 돌려준다', () => {
    expect(toKoreanUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(toKoreanUrl('정보 없음')).toBe('정보 없음');
  });

  it('바꾼 뒤에도 허용 호스트여야 한다 — 필터에 걸려 버려지면 안 된다', () => {
    for (const url of [
      'https://www.trip.com/hotels/x',
      'https://www.hotels.com/ho1/',
      'https://www.klook.com/en-US/hotel/1/',
      'https://www.myrealtrip.com/offers/1',
    ]) {
      expect(isAllowedSourceUrl(toKoreanUrl(url))).toBe(true);
    }
  });

  it('스카이스캐너는 국가 도메인을 .co.kr 로 돌리고 경로는 그대로 둔다', () => {
    // 이 사이트는 없는 경로에도 200 을 주는 SPA 라 404 판정이 못 걸러낸다 —
    // 경로를 건드리지 않는 게 특히 중요하다.
    for (const host of ['www.skyscanner.net', 'www.skyscanner.com', 'www.skyscanner.co.kr']) {
      const out = new URL(toKoreanUrl(`https://${host}/transport/flights/sel/tyoa/`));
      expect(out.hostname).toBe('www.skyscanner.co.kr');
      expect(out.pathname).toBe('/transport/flights/sel/tyoa/');
    }
  });
});

describe('항공권 예약 링크', () => {
  it('세 곳만 통과시킨다 — 항공권을 안 파는 곳과 지어낸 호스트는 버린다', () => {
    for (const url of [
      'https://kr.trip.com/flights/seoul-to-tokyo/',
      'https://www.myrealtrip.com/flights/ICN-NRT',
      'https://www.skyscanner.co.kr/transport/flights/sel/tyoa/',
      'https://www.skyscanner.net/transport/flights/sel/tyoa/',
    ]) {
      expect(isAllowedFlightUrl(url)).toBe(true);
    }

    for (const url of [
      'https://www.klook.com/ko/flights/', // 항공권을 팔지 않는다
      'https://flight.naver.com/flights/', // 프롬프트가 막는 곳
      'https://www.notskyscanner.com/x', // 호스트가 겹쳐 보이는 함정
      'http://www.skyscanner.co.kr/x', // https 가 아니다
    ]) {
      expect(isAllowedFlightUrl(url)).toBe(false);
    }
  });

  it('국가 도메인이 달라도 플랫폼 이름은 하나다 — 줄이 갈라지면 안 된다', () => {
    const merchants = [
      'https://www.skyscanner.net/transport/flights/sel/tyoa/',
      'https://www.skyscanner.com/transport/flights/sel/tyoa/',
      'https://www.skyscanner.co.kr/transport/flights/sel/tyoa/',
    ].map((url) => flightMerchantOf(url));
    expect(new Set(merchants)).toEqual(new Set(['skyscanner']));
  });

  it('허용 목록과 프롬프트 문구가 어긋나지 않는다 — 어긋나면 결과가 전부 버려진다', () => {
    for (const host of FLIGHT_ALLOWED_HOSTS) {
      // .net/.com 은 한국어 도메인(.co.kr)이 대표로 적혀 있으면 된다
      const shown = host.startsWith('skyscanner') ? 'skyscanner.co.kr' : host;
      expect(FLIGHT_ALLOWED_SITES_TEXT).toContain(shown);
    }
  });
});

/**
 * 웹 검색 인용 제거.
 *
 * `web_search` 를 켜면 모델이 구조화 출력의 string 안에 출처를 마크다운 링크로
 * 박아 보낸다. 프롬프트로 막아도 샌다 — 실제로 오사카 호텔 설명에 들어와
 * DB 까지 저장됐다. 카드 설명은 40자라 대부분 잘리는데, **잘린 자리에
 * `([kr.trip` 같은 조각이 남아** 사용자에게는 깨진 글자로 보인다.
 */
describe('웹 검색 인용 제거', () => {
  it('괄호째 붙은 인용은 통째로 지운다 — 운영에서 실제로 저장된 값이다', () => {
    expect(
      textWithoutCitations(
        '중심 상업지구, 난바역 직결. ([kr.trip.com](https://kr.trip.com/hotels/osaka-hotel-detail-976800/?utm_source=openai))',
      ),
    ).toBe('중심 상업지구, 난바역 직결.');
  });

  it('인용이 여러 개여도 전부 지운다', () => {
    expect(
      textWithoutCitations('도톤보리 인근. ([a.com](https://a.com)) 조식 포함. ([b.com](https://b.com))'),
    ).toBe('도톤보리 인근. 조식 포함.');
  });

  /** 괄호 없이 문장에 녹아 있으면 그 글자는 내용이다 — 지우면 말이 끊긴다. */
  it('문장 속 마크다운 링크는 라벨만 남긴다', () => {
    expect(textWithoutCitations('[난바역](https://x.com) 도보 3분')).toBe('난바역 도보 3분');
  });

  it('인용이 없으면 그대로 둔다', () => {
    expect(textWithoutCitations('난바역 직결, 조식 포함')).toBe('난바역 직결, 조식 포함');
  });

  /** text() 의 규칙을 그대로 물려받는다 — 인용만 남은 문자열은 빈손이다. */
  it('지우고 나서 빈 문자열이면 null', () => {
    expect(textWithoutCitations('([kr.trip.com](https://kr.trip.com))')).toBeNull();
    expect(textWithoutCitations('정보 없음')).toBeNull();
    expect(textWithoutCitations(null)).toBeNull();
  });
});

/**
 * 예약 링크를 다루는 공통 규칙.
 *
 * 호텔과 항공권이 같은 제휴몰(trip.com, myrealtrip.com …)을 쓰기 때문에
 * "이 호스트를 믿을 수 있나 / 한국어 페이지로 어떻게 돌리나" 는 도메인마다
 * 달라질 이유가 없다. 두 provider 가 각자 갖고 있으면 한쪽만 고쳐지고,
 * 그러면 같은 사이트에서 호텔은 한국어인데 항공권은 영어로 나간다.
 *
 * 도메인별로 다른 것은 **어떤 호스트를 허용하는가** 뿐이다. 그건 호출부가 준다
 * (호텔은 네 곳, 항공권은 항공권을 실제로 파는 두 곳).
 */

/** `trip.com` 과 `kr.trip.com` 은 같게 보고, `nottrip.com` 은 다르게 본다. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/**
 * 신뢰하는 예약 호스트인가.
 *
 * 모델은 없는 URL 을 그럴듯하게 만들어낸다. 그게 애드픽 변환을 타고 사용자에게
 * 나가면 404 로 떨어진다. 호스트라도 걸러서 피해를 줄인다.
 * https 만 통과시킨다 — 예약 페이지가 평문 http 인 경우는 없다.
 */
export function allowedHost(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return hosts.some((allowed) => hostMatches(parsed.hostname, allowed));
  } catch {
    return false;
  }
}

/** 주소에서 제휴몰 이름을 뽑는다 (`kr.trip.com/...` → `trip`). 모르는 곳이면 null. */
export function merchantFrom(url: string, hosts: readonly string[]): string | null {
  try {
    const host = new URL(url).hostname;
    const match = hosts.find((allowed) => hostMatches(host, allowed));
    return match ? match.split('.')[0] : null;
  } catch {
    return null;
  }
}

/**
 * 예약 링크를 한국어 페이지로 돌린다.
 *
 * 모델은 검색 결과에 나온 주소를 그대로 주는데, 그게 영문 페이지인 경우가 많다.
 * 프롬프트로도 시키지만 매번 지킨다는 보장이 없어서 여기서 한 번 더 고친다.
 *
 * ⚠️ **경로는 건드리지 않는 것을 원칙으로 한다.** 잘못 고치면 404 가 되는데,
 *    그건 영어 페이지가 뜨는 것보다 나쁘다. 호스트/쿼리처럼 되돌리기 쉬운 것만 손댄다.
 *
 * 근거:
 *   - trip.com    : kr.trip.com 200 확인. 로케일이 서브도메인이다
 *   - hotels.com  : kr.hotels.com 존재 확인(429 는 봇 차단이지 없는 호스트가 아니다)
 *   - klook.com   : /{locale}/ 경로 규약. 있으면 ko 로 바꾸고, 없으면 손대지 않는다
 *   - myrealtrip  : 국내 서비스라 이미 한국어
 */
export function toKoreanUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const on = (domain: string) => hostMatches(parsed.hostname, domain);

  if (on('trip.com')) {
    parsed.hostname = 'kr.trip.com';
    parsed.searchParams.set('locale', 'ko-KR');
    parsed.searchParams.set('curr', 'KRW');
    return parsed.toString();
  }

  if (on('hotels.com')) {
    parsed.hostname = 'kr.hotels.com';
    return parsed.toString();
  }

  if (on('klook.com')) {
    // /en-US/hotel/... → /ko/hotel/...  (경로 모양이 같으니 안전하다)
    // 로케일 구간이 없으면 그냥 둔다 — 없는 걸 끼워 넣다가 404 를 만들지 않는다.
    const segments = parsed.pathname.split('/');
    if (segments.length > 1 && isLocaleSegment(segments[1])) {
      segments[1] = 'ko';
      parsed.pathname = segments.join('/');
    }
    return parsed.toString();
  }

  return url;
}

/** ko, en, en-US, zh-CN 같은 로케일 구간인지. 'hotel' 같은 일반 경로와 구분해야 한다. */
function isLocaleSegment(segment: string): boolean {
  return /^[a-z]{2}(-[a-zA-Z]{2,4})?$/.test(segment);
}

/**
 * 한국어로 바꾼 주소가 실제로 살아 있는지 보고, 죽었으면 원본으로 되돌린다.
 *
 * 사이트마다 로케일 URL 규칙이 다르고 문서화돼 있지도 않다. 규칙을 추측해서 박아두면
 * 그 추측이 틀린 사이트에서 **전부 404** 가 된다 — 영어 페이지보다 나쁜 결과다.
 * 그래서 추측하지 말고 확인한다.
 *
 * ⚠️ **404 로 확인된 경우에만 되돌린다.**
 *    이 사이트들은 봇을 막아서 403·429 를 자주 준다. 그건 "주소가 틀렸다"는 증거가
 *    아니라 "우리가 봇으로 보인다"는 뜻이다. 그걸 근거로 되돌리면 멀쩡한 한국어 링크를
 *    전부 영어로 돌려놓게 된다.
 */
export function chooseUrl(
  original: string,
  localized: string,
  localizedStatus: number | null,
  originalStatus: number | null,
): string {
  if (localized === original) return original;

  const dead = (s: number | null) => s === 404 || s === 410;

  // 한국어 주소가 죽은 게 확인됐고, 원본은 죽지 않았을 때만 되돌린다.
  if (dead(localizedStatus) && !dead(originalStatus)) return original;
  return localized;
}

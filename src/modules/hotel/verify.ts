/**
 * **호텔 후보가 실제 검색 결과에서 왔는지, 그 페이지가 그 호텔인지** 가리는 도구들.
 *
 * 모델은 JSON 에 주소를 **타이핑**한다. 검색 결과에서 본 주소를 옮겨 적을 수도 있고,
 * 그럴듯하게 지어낼 수도 있고, 도시 목록 페이지를 호텔마다 붙일 수도 있다. 여기 있는
 * 것은 그 셋을 모델의 말이 아니라 **바깥의 증거**로 가리는 함수들이다 —
 *
 *   · `urlKey`          : 검색 도구가 돌려준 출처 목록과 대조하는 열쇠
 *   · `nameMatchesTitle`: 상세 페이지 제목에 그 호텔 이름이 있는가
 *   · `nameKey`         : 사이트가 달라도 같은 호텔이면 같은 열쇠
 */

/**
 * 주소 대조용 열쇠. **같은 페이지의 표기 차이를 지운다.**
 *
 *   · 서브도메인 로케일·모바일(`www.` `kr.` `m.` `ko.`) — 모델에게 한국어 주소를
 *     시키므로 모델은 `kr.trip.com` 을, 검색 결과는 `www.trip.com` 을 줄 수 있다
 *   · 경로 첫 칸의 로케일(`/ko/` `/en-US/`) — 클룩이 그렇다
 *   · 끝 슬래시, 대소문자, 쿼리 — 단 **트립닷컴 `hotelId` 는 남긴다.** 그 사이트의
 *     상세 주소는 경로가 `/hotels/detail/` 하나라 그게 곧 호텔 신원이다
 *
 * 못 읽는 주소는 null — 대조에서 떨어진다.
 */
export function urlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(?:www|kr|m|ko)\./, '');
    const path = parsed.pathname
      .toLowerCase()
      .replace(/^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/, '')
      .replace(/\/+$/, '');
    const hotelId = parsed.searchParams.get('hotelId') ?? parsed.searchParams.get('hotelid');
    return `${host}${path}${hotelId ? `#${hotelId}` : ''}`;
  } catch {
    return null;
  }
}

/** 출처 목록을 대조용 집합으로. */
export function sourceKeys(sources: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const source of sources) {
    const key = urlKey(source);
    if (key) keys.add(key);
  }
  return keys;
}

/** 이 주소가 검색 도구가 돌려준 출처 중 하나인가. */
export function isGrounded(url: string, keys: ReadonlySet<string>): boolean {
  const key = urlKey(url);
  return Boolean(key && keys.has(key));
}

// ------------------------------------------------------------ 호텔 이름
/**
 * 호텔 이름에서 **그 호텔을 가리키지 않는 말.** 이것만 겹쳐서는 같은 호텔이라 할 수 없다.
 * (「오사카 호텔」 목록 페이지 제목에도 「호텔」은 있다)
 */
const GENERIC_WORDS = new Set([
  'hotel', 'hotels', 'inn', 'resort', 'resorts', 'spa', 'suites', 'suite', 'hostel',
  'the', 'and', 'by', 'of', 'at', 'in', 'city', 'center', 'centre', 'station',
  '호텔', '리조트', '호스텔', '게스트하우스', '레지던스', '스위트', '인', '앤', '바이', '역',
]);

/** 비교용 단어들. 소문자·문장부호 제거, 의미 없는 말과 도시 이름은 뺀다. */
function significantWords(text: string, cityNames: readonly (string | null | undefined)[]): string[] {
  // 도시 이름은 **한글과 영문(slug) 둘 다** 뺀다. 「Cross Hotel Osaka」와
  // 「Hotel Granvia Osaka」가 osaka 하나로 같은 호텔이 되면 안 된다.
  const city = new Set(cityNames.flatMap((n) => words(n ?? '')));
  return words(text).filter((word) => {
    if (GENERIC_WORDS.has(word) || city.has(word)) return false;
    // 영문은 세 글자부터, 한글은 두 글자부터 — 짧은 조각은 아무 제목에나 걸린다.
    return /[가-힣]/.test(word) ? word.length >= 2 : word.length >= 3;
  });
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * **상세 페이지 제목에 그 호텔 이름이 있는가.**
 *
 * 모델은 「호텔 그란비아 오사카 (Hotel Granvia Osaka)」처럼 한·영을 같이 쓰고,
 * 페이지 제목은 둘 중 하나로만 나온다. 그래서 **의미 있는 단어 하나라도** 겹치면
 * 같은 호텔로 본다 — 「그란비아」 또는 「granvia」.
 *
 * ⚠️ **판단할 단어가 없으면 맞는 것으로 본다.** 이름이 「오사카 호텔」뿐이면 비교할
 *    거리가 없는데, 그걸 틀렸다고 하면 멀쩡한 줄이 빠진다. 이 검사가 잡으려는 것은
 *    **다른 호텔 · 목록 페이지**이고, 그건 의미 있는 단어가 하나도 안 겹치는 경우다.
 */
export function nameMatchesTitle(
  name: string,
  title: string,
  /** 「오사카」·`osaka` 처럼 그 도시를 가리키는 말. 비교에서 뺀다. */
  cityNames: readonly (string | null | undefined)[],
): boolean {
  const wanted = significantWords(name, cityNames);
  if (!wanted.length) return true;
  const have = new Set(words(title));
  const haystack = title.toLowerCase();
  // 한글은 띄어쓰기가 사이트마다 달라서(「그란비아오사카」) 부분 문자열로도 본다.
  return wanted.some((word) => have.has(word) || (/[가-힣]/.test(word) && haystack.includes(word)));
}

/** HTML 에서 페이지 제목. `og:title` 이 있으면 그것, 없으면 `<title>`. */
export function pageTitleOf(html: string): string | null {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  const title = og?.[1] ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const cleaned = title ? decodeEntities(title).trim() : '';
  return cleaned || null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/**
 * 사이트가 달라도 같은 호텔이면 같은 열쇠. **사이트별로 따로 찾으므로** 같은 호텔이
 * 트립닷컴·호텔스닷컴에서 한 번씩 올 수 있다.
 *
 * 영문 병기가 있으면 영문으로 본다 — 한글 표기는 사이트마다 흔들린다
 * (「그란비아」/「그랑비아」). 없으면 한글 전체를 붙여 쓴다.
 */
export function nameKey(name: string): string {
  const english = /[(（]([^)）]*[a-z][^)）]*)[)）]/i.exec(name)?.[1];
  return words(english ?? name).join('');
}

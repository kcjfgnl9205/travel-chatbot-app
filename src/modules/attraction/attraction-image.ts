/**
 * 관광지 대표 이미지를 위키백과에서 찾는다.
 *
 * **왜 호텔처럼 페이지를 긁지 않나** — 호텔은 예약 페이지가 있어서 거기서 og:image 를
 * 읽었다([thumbnail.ts](../hotel/thumbnail.ts)). 관광지는 긁어올 페이지 자체가 없다.
 * 모델에게 이미지 주소를 시키면 그럴듯한 CDN 주소를 지어내고, 그건 카드에 깨진 자리만
 * 남긴다(호텔에서 확인된 것). 위키백과 API 는 **구조화된 이미지 주소**를 주므로
 * 지어낼 자리가 없다 — 지도 링크를 우리가 만드는 것과 같은 이유로 이 도메인에 맞는다.
 *
 * 키가 필요 없고 무료다. 대신 **모든 관광지에 사진이 있지는 않다.**
 * 실측 커버리지(도시 8곳 × 5곳 = 40곳):
 *
 *   | 언어 | 커버리지 | 비고 |
 *   |---|---|---|
 *   | ko 만 | 62% | 일본·유럽 100%, 동남아 0~40% |
 *   | ko → en | **87%** | 한국어 문서가 없는 동남아를 영문명이 메운다 |
 *
 * 그래서 영문명(nameEn)을 모델에게 같이 받는다. 없으면 한국어로만 찾는다.
 *
 * ⚠️ **이미지가 없는 줄이 섞인다.** 카카오 listCard 는 imageUrl 이 없는 항목을
 *    사진 없이 그린다 — 호텔도 썸네일을 못 구하면 같은 모양이 되므로 새로운 상태는
 *    아니다. 사진을 못 구했다고 그 관광지를 빼지는 않는다. 추천 자체가 사라지는 게
 *    사진 한 장 없는 것보다 나쁘다.
 *
 * ⚠️ **저작권.** 위키미디어 사진은 대부분 CC BY-SA 라 엄밀히는 저작자 표시가 필요하다.
 *    카카오 listCard 한 줄에는 링크가 하나뿐이고 그 자리는 지도가 써야 해서(클릭 추적)
 *    줄마다 출처를 달 자리가 없다. 지금은 카드 하단 버튼으로 출처를 밝힌다.
 */

import { fetchWithTimeout } from '../../common/fetch';

/** 이미지를 찾을 언어판. 순서가 곧 우선순위다. */
const WIKIS = ['ko', 'en'] as const;
export type WikiLang = (typeof WIKIS)[number];

export interface FoundImage {
  url: string;
  /** 어느 언어판에서 건졌는지. 진단에서 언어별 성공률을 본다. */
  lang: WikiLang;
  /** 실제로 매칭된 문서 제목. 엉뚱한 문서를 잡았는지 눈으로 확인할 때 쓴다. */
  title: string;
}

/**
 * 사진이 아닌 것들.
 *
 * 위키백과 검색이 관광지를 못 찾으면 **도시 문서로 떨어지고, 도시 문서의 대표
 * 이미지는 위치 지도다.** 실측에서 "마젤란 십자가 세부" 가 세부 시 문서의
 * `Ph_locator_cebu_cebu.png` 를 물고 왔다. 카드에 지도 썸네일이 박히면
 * 사진이 없는 것보다 나쁘다 — 사용자는 그게 그 장소인 줄 안다.
 */
const NOT_A_PHOTO =
  /(locator|_map|map[_-]|flag|coat[_-]of[_-]arms|emblem|seal|logo|icon|blank|banner|disambig)/i;

/** 문서 제목·관광지 이름 비교용 정규화. 띄어쓰기·문장부호 차이를 지운다. */
export function normalizeTitle(value: string): string {
  return value.replace(/[\s·・\-–—()[\],.'"`’]/g, '').toLowerCase();
}

/**
 * 이 문서가 그 관광지가 맞는가. **포함 관계만 인정한다.**
 *
 * 글자 겹침 같은 느슨한 규칙을 쓰면 그럴듯하게 틀린다 — 실측에서
 * "유니버설 스튜디오 재팬" 이 **유니버설 스튜디오 싱가포르** 사진을 물고 왔다.
 * 엉뚱한 사진은 사진이 없는 것보다 나쁘므로, 애매하면 포기하는 쪽으로 기울인다.
 *
 * 허용되는 쪽:
 *   '천문시계'        ⊂ '프라하 천문시계'
 *   '다이아몬드 헤드'  ⊂ '다이아몬드헤드산'
 *   '와이키키 해변'    ⊃ '와이키키'
 */
export function titleMatches(name: string, title: string, cityName: string): boolean {
  const n = normalizeTitle(name);
  const t = normalizeTitle(title);
  if (!n || !t) return false;

  // 도시 문서 그 자체는 관광지 사진이 아니다. 검색이 관광지를 못 찾았다는 뜻이다.
  if (t === normalizeTitle(cityName)) return false;

  return n.includes(t) || t.includes(n);
}

/** 주소가 사진으로 쓸 만한가. 지도·로고·SVG 를 걸러낸다. */
export function isUsableImage(url: string): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    // 카카오 카드는 http 이미지를 막는다.
    if (parsed.protocol !== 'https:') return false;
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }

  // SVG 는 위키백과에서 사실상 전부 도표·문장(紋章)이다. 사진은 jpg/png 로 온다.
  if (/\.svg(\/|$)/i.test(path)) return false;
  return !NOT_A_PHOTO.test(path);
}

/** API 응답에서 우리가 보는 부분만. 나머지 필드는 무시한다. */
interface WikiPage {
  title?: unknown;
  index?: unknown;
  thumbnail?: { source?: unknown } | null;
}

/**
 * 검색 결과 여러 건 중 쓸 수 있는 첫 장을 고른다.
 *
 * 순위(index)는 위키백과가 매긴 검색 적합도다. 우리가 다시 매길 근거가 없으므로
 * 그 순서대로 보되, 위 두 규칙(제목 일치·사진 여부)에 걸리면 다음 후보로 넘어간다.
 */
export function pickImage(
  pages: WikiPage[],
  name: string,
  cityName: string,
): { url: string; title: string } | null {
  const ordered = [...pages].sort(
    (a, b) => numberOr(a.index, 99) - numberOr(b.index, 99),
  );

  for (const page of ordered) {
    const title = typeof page.title === 'string' ? page.title : '';
    const source = page.thumbnail?.source;
    if (!title || typeof source !== 'string') continue;
    if (!titleMatches(name, title, cityName)) continue;
    if (!isUsableImage(source)) continue;

    // 추적 파라미터(utm_*)가 붙어 온다. 카드에 그대로 넣어도 되지만
    // 캐시·DB 에 남는 값이라 지운다 — 같은 사진이 매번 다른 주소로 보이면 안 된다.
    return { url: source.split('?')[0], title };
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 위키백과에 어떻게 물을지.
 *
 * `generator=search` 를 쓰는 이유: 정확한 문서 제목을 모르기 때문이다. 모델이 주는
 * 이름("가이유칸")과 문서 제목("가이유칸")이 늘 같지는 않아서, 제목으로 바로 찍는
 * REST summary 엔드포인트는 조금만 달라도 404 가 된다. 검색을 태우면 표기 차이를
 * 위키백과가 흡수해준다.
 *
 * 도시 이름을 검색어에 붙이는 이유는 지도 링크와 같다 — "중앙공원" 은 전 세계에 있다.
 */
export function searchUrl(lang: WikiLang, name: string, cityName: string): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '1',
    generator: 'search',
    gsrsearch: `${name} ${cityName}`.trim(),
    gsrlimit: '3',
    prop: 'pageimages',
    piprop: 'thumbnail',
    // 카카오 카드 썸네일은 작지만, 원본이 크면 기기에 따라 선명하게 나온다.
    pithumbsize: '800',
  });
  return `https://${lang}.wikipedia.org/w/api.php?${params.toString()}`;
}

/**
 * 위키미디어 API 예절.
 *
 * 봇에 연락처가 담긴 User-Agent 를 요구한다. 익명 UA 로 두들기면 차단된다.
 * https://meta.wikimedia.org/wiki/User-Agent_policy
 */
const WIKI_UA = 'travel-chatbot/0.1 (https://bot.nolmoa.com)';

async function fetchPages(url: string, timeoutMs: number): Promise<WikiPage[]> {
  try {
    return await fetchWithTimeout(
      url,
      { headers: { 'user-agent': WIKI_UA, accept: 'application/json' } },
      timeoutMs,
      async (res) => {
        if (!res.ok) return [];
        const body = (await res.json()) as { query?: { pages?: unknown } };
        const pages = body.query?.pages;
        // formatversion=1 은 객체, 2 는 배열로 준다. 둘 다 받아둔다.
        if (Array.isArray(pages)) return pages as WikiPage[];
        if (pages && typeof pages === 'object') return Object.values(pages) as WikiPage[];
        return [];
      },
    );
  } catch {
    // 사진은 있으면 좋은 것이지 없으면 안 되는 것이 아니다. 실패는 조용히 넘긴다.
    return [];
  }
}

/**
 * 관광지 하나의 대표 이미지를 찾는다. 못 찾으면 null.
 *
 * ko → en 순서로 본다. 한국어 문서가 있으면 그게 한국인에게 익숙한 장소라는 뜻이라
 * 먼저 보고, 없을 때만 영문명으로 영어판을 본다 (동남아가 여기서 메워진다).
 *
 * @param nameEn 모델이 준 영문·현지 공식명. 없으면 영어판은 건너뛴다 —
 *               영어판에 한국어를 넣어봐야 아무것도 안 나온다.
 */
export async function findAttractionImage(
  name: string,
  nameEn: string | null | undefined,
  cityName: string,
  cityNameEn: string | null | undefined,
  timeoutMs: number,
): Promise<FoundImage | null> {
  for (const lang of WIKIS) {
    const term = lang === 'ko' ? name : nameEn;
    const city = lang === 'ko' ? cityName : (cityNameEn ?? cityName);
    if (!term) continue;

    const pages = await fetchPages(searchUrl(lang, term, city), timeoutMs);
    const found = pickImage(pages, term, city);
    if (found) return { url: found.url, lang, title: found.title };
  }
  return null;
}

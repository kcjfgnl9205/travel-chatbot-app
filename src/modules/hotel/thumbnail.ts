/**
 * 예약 페이지 HTML 에서 호텔 대표 이미지를 뽑는다.
 *
 * **왜 모델에게 안 시키나** — `web_search` 는 텍스트 스니펫을 준다. 이미지 주소는
 * 검색 결과에 나오지 않으므로, 모델에게 시키면 그럴듯한 CDN 주소를 지어낸다.
 * 지어낸 주소는 카드에 깨진 자리만 남긴다. 페이지에서 직접 읽는 게 유일한 정답이다.
 *
 * 사이트마다 사정이 달라서 3단으로 내려간다 (실측 결과):
 *
 *   | 사이트        | 되는 층 |
 *   |---------------|---------|
 *   | hotels.com    | og      |
 *   | 마이리얼트립  | og      |
 *   | trip.com      | photo   (SPA 라 og 태그 자체가 없다) |
 *   | 클룩          | 페이지마다 다름 |
 *
 * ⚠️ **본문 이미지를 무작정 집으면 로고가 카드에 박힌다.** 그래서 photo 층은
 *    "URL 이 스스로 사진 크기를 말하는 것"만 받는다 (`_R_960_660_`, `1200x800`).
 *    로고·아이콘은 크기를 URL 에 박지 않는다.
 */

/** 어느 층에서 건졌는지. 진단에서 층별 성공률을 보려고 같이 돌려준다. */
export type ThumbnailSource = 'og' | 'ld' | 'photo';

export interface FoundThumbnail {
  url: string;
  source: ThumbnailSource;
}

/** 사진으로 받아줄 확장자. png 는 대부분 로고·아이콘이라 뺀다. */
const PHOTO_EXT = /\.(jpe?g|webp)(\?|$)/i;

/** 카드에 넣을 만한 최소 크기. 이보다 작으면 아이콘일 가능성이 높다. */
const MIN_PHOTO_SIDE = 300;

/**
 * og:image 라도 받으면 안 되는 것들.
 *
 * 사이트들은 상세 페이지에도 **사이트 공용 로고**를 og:image 로 박아둔다
 * (마이리얼트립의 `logos/mrt_main_og_image.png` 를 실제로 받았다).
 * 그걸 그대로 쓰면 호텔 다섯 줄이 전부 같은 로고가 된다 — 이미지가 없는 것보다 나쁘다.
 * 걸리면 아래층(ld / photo)으로 내려간다.
 */
const NOT_A_PHOTO = /(logo|og[_-]?image|default|placeholder|no[_-]?image|share|thumb_default)/i;

/**
 * URL 이 스스로 밝히는 크기. 두 가지 표기를 본다.
 *   trip.com : ..._R_960_660_R5_D.jpg  /  ..._W_480_360_R5_Q70.jpg
 *   일반     : ...1200x800.jpg
 */
export function declaredSize(url: string): { w: number; h: number } | null {
  const underscore = /_[RWC]_(\d{2,5})_(\d{2,5})_/i.exec(url);
  if (underscore) return { w: Number(underscore[1]), h: Number(underscore[2]) };

  const cross = /[_/-](\d{3,5})x(\d{3,5})[._-]/i.exec(url);
  if (cross) return { w: Number(cross[1]), h: Number(cross[2]) };

  return null;
}

/** HTML 속성값에 들어 있는 엔티티. og:image 의 &amp; 를 안 풀면 주소가 깨진다. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 페이지 주소 기준으로 절대 주소를 만든다.
 *
 * og:image 는 `//img.example.com/a.jpg` 나 `/img/a.jpg` 로도 온다.
 * 카카오는 상대 주소를 이해하지 못하므로 여기서 확정해야 한다.
 */
export function absolutize(raw: string, pageUrl: string): string | null {
  const value = decodeEntities(raw).trim();
  if (!value) return null;
  try {
    const resolved = new URL(value, pageUrl);
    // 카카오 카드는 http 이미지를 막는다. https 가 아니면 없는 것으로 친다.
    return resolved.protocol === 'https:' ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/** ① og:image / twitter:image */
function fromMeta(html: string, pageUrl: string): string | null {
  // property 와 name 을 다 본다. 순서도 사이트마다 뒤집혀 있어서 속성 위치를 고정하지 않는다.
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::url)?["'][^>]*>/gi,
    /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    for (const tag of html.match(pattern) ?? []) {
      const content = /content=["']([^"']+)["']/i.exec(tag)?.[1];
      const url = content ? absolutize(content, pageUrl) : null;
      if (url && !NOT_A_PHOTO.test(new URL(url).pathname)) return url;
    }
  }
  return null;
}

/** ② JSON-LD 의 image (문자열이거나 배열이거나 객체다) */
function fromJsonLd(html: string, pageUrl: string): string | null {
  const blocks = html.match(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    // 전체를 JSON.parse 하면 사이트 하나만 깨져도 다 놓친다. 필요한 필드만 집는다.
    const match =
      /"image"\s*:\s*"([^"]{8,400})"/i.exec(block) ??
      /"image"\s*:\s*\[\s*"([^"]{8,400})"/i.exec(block) ??
      /"(?:contentUrl|url)"\s*:\s*"([^"]{8,400}\.(?:jpe?g|webp|png))"/i.exec(block);
    const url = match ? absolutize(match[1], pageUrl) : null;
    if (url) return url;
  }
  return null;
}

/**
 * ③ 본문에서 크기가 박힌 사진.
 *
 * trip.com 처럼 og 태그가 없는 SPA 를 위한 마지막 수단이다.
 * **문서에 먼저 나오는 것이 대표 이미지**라는 가정을 쓴다 (첫 화면에 뜨는 사진).
 * 크기 미달·확장자 미달은 버리므로 로고가 뚫고 들어오지는 않는다.
 */
function fromPhotoUrls(html: string, pageUrl: string): string | null {
  const candidates = html.match(/https:\/\/[^"'\s\\<>]{20,300}/g) ?? [];
  for (const raw of candidates) {
    if (!PHOTO_EXT.test(raw)) continue;
    const size = declaredSize(raw);
    if (!size || size.w < MIN_PHOTO_SIDE || size.h < MIN_PHOTO_SIDE) continue;
    const url = absolutize(raw, pageUrl);
    if (url && !NOT_A_PHOTO.test(new URL(url).pathname)) return url;
  }
  return null;
}

/** 3단을 순서대로 시도한다. 위층이 더 믿을 만하다. */
export function extractThumbnail(html: string, pageUrl: string): FoundThumbnail | null {
  const og = fromMeta(html, pageUrl);
  if (og) return { url: og, source: 'og' };

  const ld = fromJsonLd(html, pageUrl);
  if (ld) return { url: ld, source: 'ld' };

  const photo = fromPhotoUrls(html, pageUrl);
  if (photo) return { url: photo, source: 'photo' };

  return null;
}

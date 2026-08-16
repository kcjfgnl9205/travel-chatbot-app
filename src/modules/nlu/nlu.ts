/**
 * 아주 얇은 발화 파싱.
 *
 * 오픈빌더 엔티티가 city 를 뽑아주면 그걸 쓰고, 없으면 여기서 폴백 처리한다.
 * Phase 3에서 LLM 파서로 교체할 자리.
 */

export interface City {
  slug: string;
  nameKo: string;
  countryKo: string;
  aliases: string[];
}

// 도시 마스터. 단일 소스는 여기다.
// DB 없이도(no-op 모드) 챗봇이 동작해야 해서 코드 쪽에 둔다.
export const CITIES: City[] = [
  {
    slug: 'osaka',
    nameKo: '오사카',
    countryKo: '일본',
    aliases: ['오사카', '오오사카', 'osaka', '大阪'],
  },
  {
    slug: 'tokyo',
    nameKo: '도쿄',
    countryKo: '일본',
    aliases: ['도쿄', '동경', 'tokyo', '東京'],
  },
  {
    slug: 'fukuoka',
    nameKo: '후쿠오카',
    countryKo: '일본',
    aliases: ['후쿠오카', '후쿠', 'fukuoka', '福岡'],
  },
];

const GUESTS_RE = /(\d+)\s*(?:명|인)/;
const NIGHTS_RE = /(\d+)\s*박/;

export interface ParsedQuery {
  citySlug: string | null;
  cityName: string | null;
  guests: number | null;
  nights: number | null;
}

/** 텍스트에서 도시 하나를 찾는다. 가장 먼저 등장하는 도시를 채택. */
export function matchCity(text: string | null | undefined): City | null {
  if (!text) return null;
  const lowered = text.toLowerCase();

  let best: { index: number; city: City } | null = null;
  for (const city of CITIES) {
    for (const alias of city.aliases) {
      const idx = lowered.indexOf(alias.toLowerCase());
      if (idx >= 0 && (best === null || idx < best.index)) {
        best = { index: idx, city };
      }
    }
  }
  return best?.city ?? null;
}

/** 엔티티 파라미터 우선, 없으면 발화 텍스트에서 폴백 파싱. */
export function parse(utterance: string, cityParam?: string | null): ParsedQuery {
  const city = matchCity(cityParam) ?? matchCity(utterance);
  const guests = GUESTS_RE.exec(utterance ?? '');
  const nights = NIGHTS_RE.exec(utterance ?? '');

  return {
    citySlug: city?.slug ?? null,
    cityName: city?.nameKo ?? null,
    guests: guests ? Number(guests[1]) : null,
    nights: nights ? Number(nights[1]) : null,
  };
}

export const hasCity = (p: ParsedQuery): boolean => p.citySlug !== null;

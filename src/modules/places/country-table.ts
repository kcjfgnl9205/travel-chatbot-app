/**
 * 나라 사전.
 *
 * 도시 사전([city-table.ts](./city-table.ts))과 같은 이유로 존재한다 — **모델에 맡기면
 * 흔들린다.** "독일" 을 country 로 분류할 때도 있고 도시처럼 볼 때도 있었고, 그때마다
 * 나라를 지역 하나로 검색해 뭉개진 결과가 나갔다. 나라는 수가 적고 변하지 않으므로
 * 표로 박아두는 게 맞다.
 *
 * ⚠️ **여기 있으면 모델을 아예 안 부른다.** 카카오 5초 예산에서 1.5초를 아끼고,
 *    무엇보다 **판정이 매번 같아진다.**
 *
 * 여기 없는 나라는 모델이 판정한다(그것도 country 로 나오면 똑같이 동작한다).
 * 여행지로 자주 불리는 나라부터 채웠다 — 빠진 게 보이면 추가하면 된다.
 */

export interface CountryEntry {
  /** 표준 한국어 국가명. */
  nameKo: string;
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** nameKo 외에 인정할 표기. 정규화(공백 제거·소문자)해서 넣는다. */
  aliases: string[];
}

export const COUNTRY_TABLE: CountryEntry[] = [
  // 아시아
  { nameKo: '일본', code: 'JP', aliases: ['japan', '니혼'] },
  { nameKo: '베트남', code: 'VN', aliases: ['vietnam', '월남'] },
  { nameKo: '태국', code: 'TH', aliases: ['thailand', '타이'] },
  { nameKo: '대만', code: 'TW', aliases: ['taiwan', '타이완'] },
  { nameKo: '중국', code: 'CN', aliases: ['china'] },
  { nameKo: '필리핀', code: 'PH', aliases: ['philippines'] },
  { nameKo: '싱가포르', code: 'SG', aliases: ['singapore', '싱가폴'] },
  { nameKo: '말레이시아', code: 'MY', aliases: ['malaysia', '말레이지아'] },
  { nameKo: '인도네시아', code: 'ID', aliases: ['indonesia'] },
  { nameKo: '캄보디아', code: 'KH', aliases: ['cambodia'] },
  { nameKo: '라오스', code: 'LA', aliases: ['laos'] },
  { nameKo: '몽골', code: 'MN', aliases: ['mongolia'] },
  { nameKo: '인도', code: 'IN', aliases: ['india'] },
  { nameKo: '네팔', code: 'NP', aliases: ['nepal'] },
  { nameKo: '스리랑카', code: 'LK', aliases: ['srilanka'] },
  { nameKo: '우즈베키스탄', code: 'UZ', aliases: ['uzbekistan'] },
  { nameKo: '아랍에미리트', code: 'AE', aliases: ['uae', '에미리트'] },
  { nameKo: '한국', code: 'KR', aliases: ['korea', '대한민국', '국내'] },

  // 유럽
  { nameKo: '프랑스', code: 'FR', aliases: ['france'] },
  { nameKo: '이탈리아', code: 'IT', aliases: ['italy', '이태리'] },
  { nameKo: '스페인', code: 'ES', aliases: ['spain'] },
  { nameKo: '포르투갈', code: 'PT', aliases: ['portugal'] },
  { nameKo: '독일', code: 'DE', aliases: ['germany'] },
  { nameKo: '영국', code: 'GB', aliases: ['uk', 'england', '잉글랜드'] },
  { nameKo: '스위스', code: 'CH', aliases: ['switzerland'] },
  { nameKo: '오스트리아', code: 'AT', aliases: ['austria'] },
  { nameKo: '체코', code: 'CZ', aliases: ['czech'] },
  { nameKo: '헝가리', code: 'HU', aliases: ['hungary'] },
  { nameKo: '네덜란드', code: 'NL', aliases: ['netherlands', '화란'] },
  { nameKo: '벨기에', code: 'BE', aliases: ['belgium'] },
  { nameKo: '그리스', code: 'GR', aliases: ['greece'] },
  { nameKo: '크로아티아', code: 'HR', aliases: ['croatia'] },
  { nameKo: '폴란드', code: 'PL', aliases: ['poland'] },
  { nameKo: '핀란드', code: 'FI', aliases: ['finland'] },
  { nameKo: '노르웨이', code: 'NO', aliases: ['norway'] },
  { nameKo: '스웨덴', code: 'SE', aliases: ['sweden'] },
  { nameKo: '덴마크', code: 'DK', aliases: ['denmark'] },
  { nameKo: '아이슬란드', code: 'IS', aliases: ['iceland'] },
  { nameKo: '터키', code: 'TR', aliases: ['turkey', '튀르키예'] },

  // 아메리카 · 오세아니아 · 아프리카
  { nameKo: '미국', code: 'US', aliases: ['usa', 'america', '아메리카'] },
  { nameKo: '캐나다', code: 'CA', aliases: ['canada'] },
  { nameKo: '멕시코', code: 'MX', aliases: ['mexico'] },
  { nameKo: '브라질', code: 'BR', aliases: ['brazil'] },
  { nameKo: '페루', code: 'PE', aliases: ['peru'] },
  { nameKo: '호주', code: 'AU', aliases: ['australia', '오스트레일리아'] },
  { nameKo: '뉴질랜드', code: 'NZ', aliases: ['newzealand'] },
  { nameKo: '이집트', code: 'EG', aliases: ['egypt'] },
  { nameKo: '모로코', code: 'MA', aliases: ['morocco'] },
  { nameKo: '남아프리카공화국', code: 'ZA', aliases: ['southafrica', '남아공'] },
];

/** 정규화 키 → 나라. 도시 사전과 같은 방식이다. */
export const COUNTRY_ALIASES: ReadonlyMap<string, CountryEntry> = new Map(
  COUNTRY_TABLE.flatMap((country) =>
    [country.nameKo, ...country.aliases].map(
      (alias) => [alias.replace(/\s+/g, '').toLowerCase(), country] as const,
    ),
  ),
);

/**
 * 문자열 전체가 나라인가.
 *
 * ⚠️ **전체 일치만 본다.** 부분 일치로 훑으면 "한국인이 좋아하는 오사카" 가 한국이 되고,
 *    "미국식 브런치" 가 미국이 된다. 발화에서 지명을 뽑는 건 모델의 일이고, 여기는
 *    **뽑힌 지명이 나라인지** 판정할 뿐이다.
 */
export function lookupCountry(text: string | null | undefined): CountryEntry | null {
  if (!text) return null;
  return COUNTRY_ALIASES.get(text.replace(/\s+/g, '').toLowerCase()) ?? null;
}

/** 토큰 끝에 붙는 조사. "일본은" 도 일본으로 본다. */
const PARTICLES = /(은|는|이|가|의|에|에서|으로|로|도|만|랑|와|과)$/;

/**
 * 문장에서 나라를 찾는다. **토큰 단위로만 본다.**
 *
 * ⚠️ 부분 일치로 훑으면 안 된다 — "**한국**인이 좋아하는 오사카" 가 한국이 되고,
 *    "**미국**식 브런치 맛집" 이 미국이 된다. 띄어쓰기로 끊은 조각이 통째로 나라일
 *    때만 인정한다. 도시 사전이 같은 이유로 한 글자 별칭을 토큰으로만 보는 것과 같다.
 */
export function findCountryInText(utterance: string): CountryEntry | null {
  for (const raw of utterance.split(/[\s,./]+/)) {
    const token = raw.replace(/\s+/g, '').toLowerCase();
    if (!token) continue;
    const hit = COUNTRY_ALIASES.get(token) ?? COUNTRY_ALIASES.get(token.replace(PARTICLES, ''));
    if (hit) return hit;
  }
  return null;
}

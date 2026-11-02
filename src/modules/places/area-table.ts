import { CityEntry, lookupCity, normalizeAlias } from './city-table';

/**
 * 세부 지역 사전 (도시 안의 번화가·동네).
 *
 * **도시 사전([city-table.ts](./city-table.ts))과 같은 목적, 다른 층이다.** 둘 다
 * 모델 호출을 줄이는 캐시이고 요청 경로에서 0ms 로 읽히지만, 여기 있는 것들은
 * `kind: 'area'` 이고 **부모 도시가 있다.**
 *
 * ⚠️ **왜 도시 사전에 못 넣는가.** 넣으면 "부산 해운대 호텔" 에서 도시가 둘로
 *    잡힌다 — [intent.service.ts](../intent/intent.service.ts) `fromKeywords` 는
 *    도시가 둘이면 어느 쪽이 목적지인지 못 가려 모델에 넘긴다. 해운대를 사전에
 *    넣은 보람이 그 자리에서 사라진다. 게다가 `iata` 가 딸려 와 **항공권이 해운대로
 *    노선을 잡으려 든다.**
 *
 * ⚠️ **허용 목록이 아니다.** 여기 없는 세부 지역도 전처럼 모델이 읽는다
 *    (`5f7d926` 이 그 길을 열어뒀다). 여기 있는 것은 **모델을 안 타는 지름길**일
 *    뿐이고, 그 지름길이 필요한 이유는 모델 경로가 카카오 응답 예산을 넘겨
 *    "어떤 여행을 찾으시나요?" 로 떨어지기 때문이다.
 *
 * ⚠️ **도시 이름과 겹치면 안 된다.** 겹치면 같은 지명이 도시로도 동네로도 잡혀
 *    캐시가 갈린다. 부팅 때 검사한다([assertNoCityCollision]).
 */
export interface AreaEntry {
  /** 캐시 키·DB 식별자. 영문 소문자 슬러그. */
  slug: string;
  /** 사용자에게 보여줄 표준 한국어명. */
  nameKo: string;
  /** 부모 도시의 `city-table` 슬러그. 여기 없는 슬러그면 부팅 때 걸린다. */
  citySlug: string;
  /** nameKo 외에 인정할 표기. 정규화(공백 제거·소문자)해서 넣는다. */
  aliases: string[];
}

/**
 * ⚠️ **흔한 한국어와 겹치는 이름은 넣지 않는다.** 문장에서 토큰으로 훑기 때문에
 *    "서면으로 알려줘" 의 서면이 부산 서면이 되는 식의 사고가 난다. 실제로 뺀 것들:
 *    서면(문서) · 중문(중국어) · 신촌은 남겼지만 역 이름이 붙은 꼴만 받는다.
 */
export const AREA_TABLE: AreaEntry[] = [
  // ------------------------------------------------------------- 한국
  { slug: 'haeundae', nameKo: '해운대', citySlug: 'busan', aliases: ['해운대구', '해운대역', '해운대해수욕장'] },
  { slug: 'gwangalli', nameKo: '광안리', citySlug: 'busan', aliases: ['광안리해수욕장', '광안대교'] },
  { slug: 'nampodong', nameKo: '남포동', citySlug: 'busan', aliases: ['자갈치'] },
  { slug: 'songjeong', nameKo: '송정', citySlug: 'busan', aliases: ['송정해수욕장'] },
  { slug: 'myeongdong', nameKo: '명동', citySlug: 'seoul', aliases: ['명동역'] },
  { slug: 'hongdae', nameKo: '홍대', citySlug: 'seoul', aliases: ['홍대입구', '홍익대'] },
  { slug: 'gangnam', nameKo: '강남', citySlug: 'seoul', aliases: ['강남역', '신사동', '가로수길'] },
  { slug: 'itaewon', nameKo: '이태원', citySlug: 'seoul', aliases: ['이태원역'] },
  { slug: 'jamsil', nameKo: '잠실', citySlug: 'seoul', aliases: ['잠실역', '롯데타워'] },
  { slug: 'jongno', nameKo: '종로', citySlug: 'seoul', aliases: ['인사동', '북촌'] },
  { slug: 'yeouido', nameKo: '여의도', citySlug: 'seoul', aliases: [] },
  { slug: 'seongsu', nameKo: '성수동', citySlug: 'seoul', aliases: ['성수'] },
  { slug: 'seogwipo', nameKo: '서귀포', citySlug: 'jeju', aliases: ['서귀포시'] },
  { slug: 'aewol', nameKo: '애월', citySlug: 'jeju', aliases: ['애월읍'] },
  { slug: 'seongsan', nameKo: '성산', citySlug: 'jeju', aliases: ['성산일출봉'] },
  { slug: 'gyeongpo', nameKo: '경포', citySlug: 'gangneung', aliases: ['경포대', '경포해수욕장'] },
  // ------------------------------------------------------------- 일본
  { slug: 'shinjuku', nameKo: '신주쿠', citySlug: 'tokyo', aliases: ['신쥬쿠', '신주꾸'] },
  { slug: 'shibuya', nameKo: '시부야', citySlug: 'tokyo', aliases: ['시부야역'] },
  { slug: 'ginza', nameKo: '긴자', citySlug: 'tokyo', aliases: [] },
  { slug: 'asakusa', nameKo: '아사쿠사', citySlug: 'tokyo', aliases: ['아사쿠사역', '센소지'] },
  { slug: 'ueno', nameKo: '우에노', citySlug: 'tokyo', aliases: ['우에노역'] },
  { slug: 'ikebukuro', nameKo: '이케부쿠로', citySlug: 'tokyo', aliases: [] },
  { slug: 'roppongi', nameKo: '롯폰기', citySlug: 'tokyo', aliases: ['록폰기'] },
  { slug: 'akihabara', nameKo: '아키하바라', citySlug: 'tokyo', aliases: ['아키바'] },
  { slug: 'odaiba', nameKo: '오다이바', citySlug: 'tokyo', aliases: [] },
  { slug: 'shinagawa', nameKo: '시나가와', citySlug: 'tokyo', aliases: [] },
  { slug: 'dotonbori', nameKo: '도톤보리', citySlug: 'osaka', aliases: ['도톤보리강'] },
  { slug: 'namba', nameKo: '난바', citySlug: 'osaka', aliases: ['난바역', '난바역앞'] },
  { slug: 'umeda', nameKo: '우메다', citySlug: 'osaka', aliases: ['오사카역'] },
  { slug: 'shinsaibashi', nameKo: '신사이바시', citySlug: 'osaka', aliases: ['심사이바시'] },
  { slug: 'tennoji', nameKo: '덴노지', citySlug: 'osaka', aliases: ['텐노지'] },
  { slug: 'gion', nameKo: '기온', citySlug: 'kyoto', aliases: ['기온거리'] },
  { slug: 'arashiyama', nameKo: '아라시야마', citySlug: 'kyoto', aliases: [] },
  { slug: 'hakata', nameKo: '하카타', citySlug: 'fukuoka', aliases: ['하카타역'] },
  { slug: 'tenjin', nameKo: '텐진', citySlug: 'fukuoka', aliases: ['덴진'] },
  { slug: 'nakasu', nameKo: '나카스', citySlug: 'fukuoka', aliases: [] },
  { slug: 'susukino', nameKo: '스스키노', citySlug: 'sapporo', aliases: [] },
  // ------------------------------------------------------------- 그 외
  { slug: 'ximending', nameKo: '시먼딩', citySlug: 'taipei', aliases: ['서문정'] },
  { slug: 'tsimshatsui', nameKo: '침사추이', citySlug: 'hongkong', aliases: ['짐사쪼이'] },
  { slug: 'sentosa', nameKo: '센토사', citySlug: 'singapore', aliases: ['센토사섬'] },
  { slug: 'sukhumvit', nameKo: '수쿰빗', citySlug: 'bangkok', aliases: ['수쿰윗'] },
  { slug: 'khaosan', nameKo: '카오산', citySlug: 'bangkok', aliases: ['카오산로드'] },
  { slug: 'myeongdong-danang', nameKo: '미케비치', citySlug: 'danang', aliases: ['미케해변'] },
];

/** 별칭 → 세부 지역. 긴 별칭이 먼저 오도록 정렬해 둔다 (findAreaInText 가 그 순서를 쓴다). */
const AREA_ALIASES = new Map<string, AreaEntry>();
for (const area of AREA_TABLE) {
  for (const alias of [area.nameKo, area.slug, ...area.aliases]) {
    AREA_ALIASES.set(normalizeAlias(alias), area);
  }
}

/**
 * 문자열 전체가 세부 지역인가. **이미 뽑힌 토큰 하나**를 받는다.
 *
 * `city` 를 주면 **그 도시에 속한 것만** 인정한다. "도쿄 해운대" 같은 조합을
 * 받아주면 사용자가 말하지도 않은 지역으로 검색하게 된다.
 */
export function lookupArea(
  text: string | null | undefined,
  city?: CityEntry | null,
): AreaEntry | null {
  if (!text) return null;
  const area = AREA_ALIASES.get(normalizeAlias(text)) ?? null;
  if (!area) return null;
  if (city && area.citySlug !== city.slug) return null;
  return area;
}

/**
 * 도시 없이 세부 지역만 말한 경우. "해운대 호텔" 의 `해운대` 다.
 *
 * ⚠️ **부분 일치로 훑지 않는다.** 도시 사전은 "오사카호텔" 처럼 붙여 쓴 말까지
 *    잡으려고 substring 을 쓰는데, 세부 지역에서 같은 짓을 하면 긴 문장 한가운데의
 *    글자 조각이 지명이 된다. 띄어쓰기로 끊은 토큰이 **정확히** 그 이름일 때만 받는다.
 *
 * 가장 앞에 나온 것을 쓴다 — 둘을 말하는 경우는 드물고, 그때는 앞이 주제다.
 */
export function findAreaInText(utterance: string): AreaEntry | null {
  if (!utterance.trim()) return null;
  for (const token of utterance.split(/[\s,./]+/)) {
    const area = lookupArea(token.replace(PARTICLES, ''));
    if (area) return area;
  }
  return null;
}

/** 조사·어미. city-table 과 같은 규칙이다 — 갈리면 한쪽만 잡히는 지명이 생긴다. */
const PARTICLES = /(에서|으로|에게|까지|부터|이랑|랑|은|는|이|가|을|를|의|도|로|에|와|과|만)$/;

/**
 * 세부 지역의 부모 도시. 표에 없는 슬러그를 적어두면 여기서 null 이 된다.
 *
 * ⚠️ 부모를 못 찾으면 **세부 지역으로 쓰지 않는다** — 부모 없는 area 는
 *    검색 질의에 도시가 안 붙어("신주쿠" 만으로 웹 검색) 결과가 엉뚱해진다.
 */
export function cityOfArea(area: AreaEntry): CityEntry | null {
  return lookupCity(area.citySlug);
}

/**
 * **부팅 때 한 번 검사한다.** 사전이 서로 어긋나면 조용히 틀리기 때문이다.
 *
 *   · 세부 지역 이름이 도시 사전에도 있으면 같은 지명이 둘로 갈려 캐시가 쪼개진다
 *   · 부모 슬러그가 도시 사전에 없으면 그 세부 지역은 영영 부모 없이 등록된다
 *
 * 던지지 않고 목록을 돌려준다 — 부팅을 막을 만큼 치명적이진 않고, 호출부가
 * 경고로 남긴다. 실제로 손볼 사람이 보는 건 그 로그다.
 */
export function areaTableProblems(): string[] {
  const problems: string[] = [];
  for (const area of AREA_TABLE) {
    for (const alias of [area.nameKo, ...area.aliases]) {
      const city = lookupCity(alias);
      if (city) problems.push(`${area.nameKo}: 별칭 "${alias}" 이 도시(${city.nameKo})와 겹친다`);
    }
    if (!lookupCity(area.citySlug)) {
      problems.push(`${area.nameKo}: 부모 도시 "${area.citySlug}" 가 도시 사전에 없다`);
    }
  }
  return problems;
}

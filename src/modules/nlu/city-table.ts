/**
 * 도시 사전.
 *
 * **오픈빌더 커스텀 엔티티 `여행도시` 와 같은 목록이다.** 양쪽이 어긋나면
 * "카카오는 도시로 뽑았는데 서버는 모르는 도시" 같은 상태가 생긴다.
 * 엔티티에 도시를 추가하면 여기에도 같이 추가해야 한다.
 *
 * 쓰임새가 셋이다.
 *
 *   1. **표기 통일.** 엔티티는 "동경"·"Tokyo" 를 그대로 넘겨줄 수 있다. 슬러그로
 *      모아두지 않으면 같은 도시가 캐시에서 갈린다 (entity 경로는 `도쿄`,
 *      모델 경로는 `tokyo` 로 저장되던 문제).
 *   2. **공짜 폴백 파서.** 엔티티가 안 왔을 때 모델을 부르기 전에 먼저 본다.
 *      0ms·0원이고, 2.5초 파싱 타임아웃에 걸려 되묻던 경우를 없애준다.
 *   3. **공항 코드.** 항공권은 도착지 IATA 가 있으면 검색 품질이 올라간다.
 *
 * ⚠️ 허용 목록이 아니다. 여기 없는 도시는 여전히 모델이 파싱한다.
 */

export interface CityEntry {
  /** 캐시 키·DB 식별자. 영문 소문자 슬러그. */
  slug: string;
  /** 사용자에게 보여줄 표준 한국어 도시명. */
  nameKo: string;
  /** 대표 공항 IATA 3자. 공항이 없는 도시는 null (교토·강릉·인터라켄). */
  iata: string | null;
  /** nameKo 외에 인정할 표기. 정규화(공백 제거·소문자)해서 넣는다. */
  aliases: string[];
}

export const CITY_TABLE: CityEntry[] = [
  // ------------------------------------------------------------------ 일본 17
  { slug: 'tokyo', nameKo: '도쿄', iata: 'NRT', aliases: ['토쿄', '동경', 'tokyo'] },
  { slug: 'osaka', nameKo: '오사카', iata: 'KIX', aliases: ['오오사카', 'osaka'] },
  { slug: 'kyoto', nameKo: '교토', iata: 'KIX', aliases: ['쿄토', 'kyoto'] },
  { slug: 'fukuoka', nameKo: '후쿠오카', iata: 'FUK', aliases: ['후쿠오까', 'fukuoka'] },
  { slug: 'sapporo', nameKo: '삿포로', iata: 'CTS', aliases: ['삽포로', 'sapporo'] },
  { slug: 'okinawa', nameKo: '오키나와', iata: 'OKA', aliases: ['오끼나와', 'okinawa', '나하', 'naha'] },
  { slug: 'nagoya', nameKo: '나고야', iata: 'NGO', aliases: ['nagoya'] },
  { slug: 'tokyo-disney', nameKo: '도쿄디즈니', iata: 'NRT', aliases: ['도쿄디즈니랜드', '동경디즈니', 'tokyodisney'] },
  { slug: 'oita', nameKo: '오이타', iata: 'OIT', aliases: ['oita'] },
  { slug: 'beppu', nameKo: '벳푸', iata: 'OIT', aliases: ['벳부', 'beppu'] },
  { slug: 'kumamoto', nameKo: '구마모토', iata: 'KMJ', aliases: ['쿠마모토', 'kumamoto'] },
  { slug: 'kagoshima', nameKo: '가고시마', iata: 'KOJ', aliases: ['카고시마', 'kagoshima'] },
  { slug: 'nagasaki', nameKo: '나가사키', iata: 'NGS', aliases: ['nagasaki'] },
  { slug: 'hiroshima', nameKo: '히로시마', iata: 'HIJ', aliases: ['hiroshima'] },
  { slug: 'kobe', nameKo: '고베', iata: 'UKB', aliases: ['코베', 'kobe'] },
  { slug: 'yokohama', nameKo: '요코하마', iata: 'HND', aliases: ['yokohama'] },
  { slug: 'chitose', nameKo: '치토세', iata: 'CTS', aliases: ['신치토세', 'chitose'] },

  // ------------------------------------------------------------------ 한국 5
  { slug: 'seoul', nameKo: '서울', iata: 'ICN', aliases: ['seoul', '인천'] },
  { slug: 'busan', nameKo: '부산', iata: 'PUS', aliases: ['busan', 'pusan'] },
  { slug: 'jeju', nameKo: '제주', iata: 'CJU', aliases: ['제주도', 'jeju'] },
  { slug: 'gangneung', nameKo: '강릉', iata: null, aliases: ['gangneung'] },
  { slug: 'yeosu', nameKo: '여수', iata: 'RSU', aliases: ['yeosu'] },

  // ---------------------------------------------------------------- 동남아 15
  { slug: 'bangkok', nameKo: '방콕', iata: 'BKK', aliases: ['bangkok'] },
  { slug: 'chiang-mai', nameKo: '치앙마이', iata: 'CNX', aliases: ['chiangmai'] },
  { slug: 'phuket', nameKo: '푸껫', iata: 'HKT', aliases: ['푸켓', 'phuket'] },
  { slug: 'danang', nameKo: '다낭', iata: 'DAD', aliases: ['다당', 'danang'] },
  { slug: 'nha-trang', nameKo: '나트랑', iata: 'CXR', aliases: ['냐짱', 'nhatrang'] },
  { slug: 'hanoi', nameKo: '하노이', iata: 'HAN', aliases: ['hanoi'] },
  { slug: 'ho-chi-minh', nameKo: '호치민', iata: 'SGN', aliases: ['호찌민', '사이공', 'hochiminh', 'saigon'] },
  { slug: 'singapore', nameKo: '싱가포르', iata: 'SIN', aliases: ['싱가폴', 'singapore'] },
  { slug: 'cebu', nameKo: '세부', iata: 'CEB', aliases: ['cebu'] },
  { slug: 'boracay', nameKo: '보라카이', iata: 'MPH', aliases: ['boracay'] },
  { slug: 'manila', nameKo: '마닐라', iata: 'MNL', aliases: ['manila'] },
  { slug: 'bali', nameKo: '발리', iata: 'DPS', aliases: ['bali', '덴파사르'] },
  { slug: 'jakarta', nameKo: '자카르타', iata: 'CGK', aliases: ['jakarta'] },
  { slug: 'kuala-lumpur', nameKo: '쿠알라룸푸르', iata: 'KUL', aliases: ['쿠알라룸프르', 'kualalumpur'] },
  { slug: 'kota-kinabalu', nameKo: '코타키나발루', iata: 'BKI', aliases: ['코타키나바루', 'kotakinabalu'] },

  // ---------------------------------------------------------------- 중화권 7
  { slug: 'hong-kong', nameKo: '홍콩', iata: 'HKG', aliases: ['hongkong'] },
  { slug: 'macau', nameKo: '마카오', iata: 'MFM', aliases: ['macau', 'macao'] },
  { slug: 'taipei', nameKo: '타이베이', iata: 'TPE', aliases: ['타이페이', '대북', 'taipei'] },
  { slug: 'kaohsiung', nameKo: '가오슝', iata: 'KHH', aliases: ['카오슝', 'kaohsiung'] },
  { slug: 'shanghai', nameKo: '상하이', iata: 'PVG', aliases: ['상해', 'shanghai'] },
  { slug: 'beijing', nameKo: '베이징', iata: 'PEK', aliases: ['북경', 'beijing'] },
  { slug: 'qingdao', nameKo: '칭다오', iata: 'TAO', aliases: ['청도', 'qingdao'] },

  // ------------------------------------------------------- 대양주·태평양 6
  { slug: 'guam', nameKo: '괌', iata: 'GUM', aliases: ['guam'] },
  { slug: 'saipan', nameKo: '사이판', iata: 'SPN', aliases: ['saipan'] },
  { slug: 'hawaii', nameKo: '하와이', iata: 'HNL', aliases: ['호놀룰루', 'hawaii', 'honolulu'] },
  { slug: 'sydney', nameKo: '시드니', iata: 'SYD', aliases: ['sydney'] },
  { slug: 'melbourne', nameKo: '멜버른', iata: 'MEL', aliases: ['멜번', 'melbourne'] },
  { slug: 'auckland', nameKo: '오클랜드', iata: 'AKL', aliases: ['auckland'] },

  // ----------------------------------------------------------------- 유럽 18
  { slug: 'paris', nameKo: '파리', iata: 'CDG', aliases: ['paris'] },
  { slug: 'london', nameKo: '런던', iata: 'LHR', aliases: ['london'] },
  { slug: 'rome', nameKo: '로마', iata: 'FCO', aliases: ['roma', 'rome'] },
  { slug: 'barcelona', nameKo: '바르셀로나', iata: 'BCN', aliases: ['barcelona'] },
  { slug: 'madrid', nameKo: '마드리드', iata: 'MAD', aliases: ['madrid'] },
  { slug: 'prague', nameKo: '프라하', iata: 'PRG', aliases: ['prague', 'praha'] },
  { slug: 'venice', nameKo: '베네치아', iata: 'VCE', aliases: ['베니스', 'venice', 'venezia'] },
  { slug: 'florence', nameKo: '피렌체', iata: 'FLR', aliases: ['플로렌스', 'florence', 'firenze'] },
  { slug: 'milan', nameKo: '밀라노', iata: 'MXP', aliases: ['밀란', 'milan', 'milano'] },
  { slug: 'munich', nameKo: '뮌헨', iata: 'MUC', aliases: ['munich', 'muenchen'] },
  { slug: 'berlin', nameKo: '베를린', iata: 'BER', aliases: ['berlin'] },
  { slug: 'amsterdam', nameKo: '암스테르담', iata: 'AMS', aliases: ['암스텔담', 'amsterdam'] },
  { slug: 'zurich', nameKo: '취리히', iata: 'ZRH', aliases: ['쮜리히', 'zurich'] },
  { slug: 'interlaken', nameKo: '인터라켄', iata: null, aliases: ['interlaken'] },
  { slug: 'vienna', nameKo: '빈', iata: 'VIE', aliases: ['비엔나', 'vienna', 'wien'] },
  { slug: 'budapest', nameKo: '부다페스트', iata: 'BUD', aliases: ['budapest'] },
  { slug: 'lisbon', nameKo: '리스본', iata: 'LIS', aliases: ['리스보아', 'lisbon', 'lisboa'] },
  { slug: 'athens', nameKo: '아테네', iata: 'ATH', aliases: ['athens'] },

  // ----------------------------------------------------------------- 미주 10
  { slug: 'new-york', nameKo: '뉴욕', iata: 'JFK', aliases: ['newyork'] },
  { slug: 'los-angeles', nameKo: '로스앤젤레스', iata: 'LAX', aliases: ['로스엔젤레스', 'losangeles'] },
  { slug: 'las-vegas', nameKo: '라스베이거스', iata: 'LAS', aliases: ['라스베가스', 'lasvegas'] },
  { slug: 'san-francisco', nameKo: '샌프란시스코', iata: 'SFO', aliases: ['샌프란', 'sanfrancisco'] },
  { slug: 'seattle', nameKo: '시애틀', iata: 'SEA', aliases: ['seattle'] },
  { slug: 'chicago', nameKo: '시카고', iata: 'ORD', aliases: ['chicago'] },
  { slug: 'boston', nameKo: '보스턴', iata: 'BOS', aliases: ['보스톤', 'boston'] },
  { slug: 'orlando', nameKo: '올랜도', iata: 'MCO', aliases: ['올란도', 'orlando'] },
  { slug: 'vancouver', nameKo: '밴쿠버', iata: 'YVR', aliases: ['벤쿠버', 'vancouver'] },
  { slug: 'toronto', nameKo: '토론토', iata: 'YYZ', aliases: ['toronto'] },

  // ----------------------------------------------------------------- 기타 7
  { slug: 'dubai', nameKo: '두바이', iata: 'DXB', aliases: ['dubai'] },
  { slug: 'istanbul', nameKo: '이스탄불', iata: 'IST', aliases: ['istanbul'] },
  { slug: 'cairo', nameKo: '카이로', iata: 'CAI', aliases: ['cairo'] },
  { slug: 'delhi', nameKo: '델리', iata: 'DEL', aliases: ['뉴델리', 'delhi', 'newdelhi'] },
  { slug: 'mumbai', nameKo: '뭄바이', iata: 'BOM', aliases: ['mumbai'] },
  { slug: 'ulaanbaatar', nameKo: '울란바토르', iata: 'UBN', aliases: ['울란바타르', 'ulaanbaatar'] },
  { slug: 'vladivostok', nameKo: '블라디보스토크', iata: 'VVO', aliases: ['블라디', 'vladivostok'] },
];

/** 별칭 → 도시. 키는 공백을 지우고 소문자로 맞춘 형태다. */
export const CITY_ALIASES: ReadonlyMap<string, CityEntry> = new Map(
  CITY_TABLE.flatMap((city) =>
    [city.slug, city.nameKo, ...city.aliases].map(
      (alias) => [normalizeAlias(alias), city] as const,
    ),
  ),
);

/**
 * 문장 파서에서만 제외하는 말들.
 *
 * "세부" 는 도시이면서 일반 명사이기도 하다. 엔티티로 온 "세부" 는 카카오가
 * 도시로 확정한 값이라 안전하지만, 문장에서 긁을 때는 "세부 사항" 이 필리핀
 * 세부로 잡힌다. 문장 파서 경로에서만 지운다.
 */
const AMBIGUOUS = /세부\s*(사항|내용|정보|사양|항목|조건|일정)/g;

/**
 * 문장에서 긁으면 안 되는 별칭.
 *
 * "빈" 은 오스트리아 수도이면서 "빈 방"·"빈 자리" 의 그 빈이다. 문장 파서가 이걸
 * 도시로 잡으면 "빈 방 있는 호텔" 이 비엔나 검색이 된다. 엔티티로 온 "빈" 은
 * 카카오가 도시로 확정한 값이라 그대로 쓴다 — 막는 건 문장 경로뿐이다.
 * (비엔나 · vienna · wien 은 그대로 인정한다)
 */
const UTTERANCE_UNSAFE = new Set(['빈']);

/** 조사·어미. 토큰 단위 매칭에서만 떼어낸다 ("괌에서" → "괌"). */
const PARTICLES = /(에서|으로|에게|까지|부터|이랑|랑|은|는|이|가|을|를|의|도|로|에|와|과|만)$/;

export function normalizeAlias(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * 문자열 전체가 도시인가. 엔티티 값·파라미터를 표준화할 때 쓴다.
 *
 * 부분 일치가 아니다 — "오사카 호텔" 은 여기서 null 이다. 엔티티는 도시만
 * 담아 오므로 전체 일치로 보는 게 맞고, 문장은 findCityInText 가 맡는다.
 */
export function lookupCity(text: string | null | undefined): CityEntry | null {
  if (!text) return null;
  return CITY_ALIASES.get(normalizeAlias(text)) ?? null;
}

/**
 * 문장에서 도시를 찾는다. **가장 긴 별칭이 이긴다.**
 *
 * 짧은 별칭부터 훑으면 "도쿄디즈니" 가 "도쿄" 로 잡히고, 그러면 디즈니랜드
 * 근처를 물은 사람에게 신주쿠 호텔이 나간다.
 *
 * 한 글자 별칭(괌·빈)은 substring 으로 보지 않는다. "빈 방 있어?" 가 오스트리아
 * 빈이 되기 때문이다. 대신 띄어쓰기로 끊은 토큰이 정확히 그 도시일 때만 인정한다.
 */
export function findCityInText(utterance: string): CityEntry | null {
  if (!utterance.trim()) return null;

  const cleaned = utterance.replace(AMBIGUOUS, ' ');
  const compact = normalizeAlias(cleaned);
  const tokens = new Set(
    cleaned
      .split(/[\s,./]+/)
      .map((token) => normalizeAlias(token).replace(PARTICLES, ''))
      .filter(Boolean),
  );

  let found: CityEntry | null = null;
  let foundLength = 0;
  let ambiguous = false;

  for (const [alias, city] of CITY_ALIASES) {
    if (alias.length < foundLength || UTTERANCE_UNSAFE.has(alias)) continue;
    const hit = alias.length >= 2 ? compact.includes(alias) : tokens.has(alias);
    if (!hit) continue;

    if (alias.length === foundLength && found && found.slug !== city.slug) {
      ambiguous = true;
      continue;
    }
    if (alias.length > foundLength) {
      found = city;
      foundLength = alias.length;
      ambiguous = false;
    }
  }

  // 같은 길이로 두 도시가 걸렸다 ("서울에서 세부 가는"). 어느 쪽이 목적지인지
  // 사전으로는 못 가린다 — 모델에 넘긴다. 틀린 도시로 검색하는 것보다 낫다.
  return ambiguous ? null : found;
}

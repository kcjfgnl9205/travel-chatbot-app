/**
 * 도시 사전.
 *
 * **오픈빌더 커스텀 엔티티 `여행도시` 와 같은 목록이다 (237개).** 양쪽이 어긋나면
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
  // ------------------------------------------------------------- 일본 36
  { slug: 'tokyo', nameKo: '도쿄', iata: 'NRT', aliases: ['토쿄', '동경'] },
  { slug: 'osaka', nameKo: '오사카', iata: 'KIX', aliases: ['오오사카'] },
  { slug: 'kyoto', nameKo: '교토', iata: 'KIX', aliases: ['쿄토'] },
  { slug: 'fukuoka', nameKo: '후쿠오카', iata: 'FUK', aliases: ['후쿠오까'] },
  { slug: 'sapporo', nameKo: '삿포로', iata: 'CTS', aliases: ['삽포로'] },
  { slug: 'okinawa', nameKo: '오키나와', iata: 'OKA', aliases: ['오끼나와', '나하'] },
  { slug: 'nagoya', nameKo: '나고야', iata: 'NGO', aliases: [] },
  { slug: 'tokyo-disney', nameKo: '도쿄디즈니', iata: 'NRT', aliases: ['도쿄디즈니랜드', '동경디즈니'] },
  { slug: 'oita', nameKo: '오이타', iata: 'OIT', aliases: [] },
  { slug: 'beppu', nameKo: '벳푸', iata: 'OIT', aliases: ['벳부'] },
  { slug: 'kumamoto', nameKo: '구마모토', iata: 'KMJ', aliases: ['쿠마모토'] },
  { slug: 'kagoshima', nameKo: '가고시마', iata: 'KOJ', aliases: ['카고시마'] },
  { slug: 'nagasaki', nameKo: '나가사키', iata: 'NGS', aliases: [] },
  { slug: 'hiroshima', nameKo: '히로시마', iata: 'HIJ', aliases: [] },
  { slug: 'kobe', nameKo: '고베', iata: 'UKB', aliases: ['코베'] },
  { slug: 'yokohama', nameKo: '요코하마', iata: 'HND', aliases: [] },
  { slug: 'chitose', nameKo: '치토세', iata: 'CTS', aliases: ['신치토세'] },
  { slug: 'yufuin', nameKo: '유후인', iata: null, aliases: [] },
  { slug: 'hakone', nameKo: '하코네', iata: null, aliases: [] },
  { slug: 'nikko', nameKo: '닛코', iata: null, aliases: ['닛꼬'] },
  { slug: 'kanazawa', nameKo: '가나자와', iata: 'KMQ', aliases: ['카나자와'] },
  { slug: 'takamatsu', nameKo: '다카마쓰', iata: 'TAK', aliases: ['다카마츠'] },
  { slug: 'matsuyama', nameKo: '마쓰야마', iata: 'MYJ', aliases: ['마츠야마'] },
  { slug: 'shizuoka', nameKo: '시즈오카', iata: 'FSZ', aliases: [] },
  { slug: 'sendai', nameKo: '센다이', iata: 'SDJ', aliases: [] },
  { slug: 'aomori', nameKo: '아오모리', iata: 'AOJ', aliases: [] },
  { slug: 'hakodate', nameKo: '하코다테', iata: 'HKD', aliases: [] },
  { slug: 'otaru', nameKo: '오타루', iata: null, aliases: [] },
  { slug: 'furano', nameKo: '후라노', iata: null, aliases: [] },
  { slug: 'biei', nameKo: '비에이', iata: null, aliases: [] },
  { slug: 'nara', nameKo: '나라', iata: null, aliases: [] },
  { slug: 'ishigaki', nameKo: '이시가키', iata: 'ISG', aliases: ['이시가키지마'] },
  { slug: 'miyakojima', nameKo: '미야코지마', iata: 'MMY', aliases: ['미야코'] },
  { slug: 'kitakyushu', nameKo: '기타큐슈', iata: 'KKJ', aliases: [] },
  { slug: 'shimonoseki', nameKo: '시모노세키', iata: null, aliases: [] },
  { slug: 'kawaguchiko', nameKo: '가와구치코', iata: null, aliases: ['가와구치', '후지산'] },
  // ------------------------------------------------------------- 한국 21
  { slug: 'seoul', nameKo: '서울', iata: 'ICN', aliases: [] },
  { slug: 'busan', nameKo: '부산', iata: 'PUS', aliases: ['pusan'] },
  { slug: 'jeju', nameKo: '제주', iata: 'CJU', aliases: ['제주도'] },
  { slug: 'gangneung', nameKo: '강릉', iata: null, aliases: [] },
  { slug: 'yeosu', nameKo: '여수', iata: 'RSU', aliases: [] },
  { slug: 'incheon', nameKo: '인천', iata: 'ICN', aliases: [] },
  { slug: 'daegu', nameKo: '대구', iata: 'TAE', aliases: [] },
  { slug: 'gwangju', nameKo: '광주', iata: 'KWJ', aliases: [] },
  { slug: 'daejeon', nameKo: '대전', iata: null, aliases: [] },
  { slug: 'ulsan', nameKo: '울산', iata: 'USN', aliases: [] },
  { slug: 'gyeongju', nameKo: '경주', iata: null, aliases: [] },
  { slug: 'jeonju', nameKo: '전주', iata: null, aliases: [] },
  { slug: 'sokcho', nameKo: '속초', iata: null, aliases: [] },
  { slug: 'gapyeong', nameKo: '가평', iata: null, aliases: [] },
  { slug: 'tongyeong', nameKo: '통영', iata: null, aliases: [] },
  { slug: 'geoje', nameKo: '거제', iata: null, aliases: [] },
  { slug: 'pohang', nameKo: '포항', iata: 'KPO', aliases: [] },
  { slug: 'namhae', nameKo: '남해', iata: null, aliases: [] },
  { slug: 'andong', nameKo: '안동', iata: null, aliases: [] },
  { slug: 'damyang', nameKo: '담양', iata: null, aliases: [] },
  { slug: 'boryeong', nameKo: '보령', iata: null, aliases: [] },
  // ------------------------------------------------------------ 동남아 37
  { slug: 'bangkok', nameKo: '방콕', iata: 'BKK', aliases: [] },
  { slug: 'chiang-mai', nameKo: '치앙마이', iata: 'CNX', aliases: [] },
  { slug: 'phuket', nameKo: '푸껫', iata: 'HKT', aliases: ['푸켓'] },
  { slug: 'pattaya', nameKo: '파타야', iata: 'UTP', aliases: [] },
  { slug: 'krabi', nameKo: '크라비', iata: 'KBV', aliases: [] },
  { slug: 'koh-samui', nameKo: '코사무이', iata: 'USM', aliases: ['사무이'] },
  { slug: 'hua-hin', nameKo: '후아힌', iata: 'HHQ', aliases: [] },
  { slug: 'danang', nameKo: '다낭', iata: 'DAD', aliases: ['다당'] },
  { slug: 'nha-trang', nameKo: '나트랑', iata: 'CXR', aliases: ['냐짱'] },
  { slug: 'hanoi', nameKo: '하노이', iata: 'HAN', aliases: [] },
  { slug: 'ho-chi-minh', nameKo: '호치민', iata: 'SGN', aliases: ['호찌민', '사이공'] },
  { slug: 'hoi-an', nameKo: '호이안', iata: 'DAD', aliases: [] },
  { slug: 'ha-long', nameKo: '하롱베이', iata: null, aliases: ['하롱'] },
  { slug: 'phu-quoc', nameKo: '푸꾸옥', iata: 'PQC', aliases: ['푸꾸억'] },
  { slug: 'da-lat', nameKo: '달랏', iata: 'DLI', aliases: ['다랏'] },
  { slug: 'sapa', nameKo: '사파', iata: null, aliases: [] },
  { slug: 'siem-reap', nameKo: '시엠립', iata: 'SAI', aliases: ['씨엠립', '앙코르와트'] },
  { slug: 'phnom-penh', nameKo: '프놈펜', iata: 'PNH', aliases: ['프놈뻰'] },
  { slug: 'vientiane', nameKo: '비엔티안', iata: 'VTE', aliases: [] },
  { slug: 'luang-prabang', nameKo: '루앙프라방', iata: 'LPQ', aliases: [] },
  { slug: 'yangon', nameKo: '양곤', iata: 'RGN', aliases: [] },
  { slug: 'singapore', nameKo: '싱가포르', iata: 'SIN', aliases: ['싱가폴'] },
  { slug: 'kuala-lumpur', nameKo: '쿠알라룸푸르', iata: 'KUL', aliases: ['쿠알라룸프르'] },
  { slug: 'kota-kinabalu', nameKo: '코타키나발루', iata: 'BKI', aliases: ['코타키나바루'] },
  { slug: 'langkawi', nameKo: '랑카위', iata: 'LGK', aliases: [] },
  { slug: 'penang', nameKo: '페낭', iata: 'PEN', aliases: [] },
  { slug: 'johor-bahru', nameKo: '조호르바루', iata: 'JHB', aliases: [] },
  { slug: 'bali', nameKo: '발리', iata: 'DPS', aliases: ['덴파사르'] },
  { slug: 'jakarta', nameKo: '자카르타', iata: 'CGK', aliases: [] },
  { slug: 'yogyakarta', nameKo: '족자카르타', iata: 'YIA', aliases: ['욕야카르타'] },
  { slug: 'lombok', nameKo: '롬복', iata: 'LOP', aliases: [] },
  { slug: 'cebu', nameKo: '세부', iata: 'CEB', aliases: [] },
  { slug: 'boracay', nameKo: '보라카이', iata: 'MPH', aliases: [] },
  { slug: 'manila', nameKo: '마닐라', iata: 'MNL', aliases: [] },
  { slug: 'palawan', nameKo: '팔라완', iata: 'PPS', aliases: [] },
  { slug: 'bohol', nameKo: '보홀', iata: 'TAG', aliases: [] },
  { slug: 'clark', nameKo: '클락', iata: 'CRK', aliases: [] },
  // ------------------------------------------------------------ 중화권 18
  { slug: 'hong-kong', nameKo: '홍콩', iata: 'HKG', aliases: [] },
  { slug: 'macau', nameKo: '마카오', iata: 'MFM', aliases: ['macao'] },
  { slug: 'taipei', nameKo: '타이베이', iata: 'TPE', aliases: ['타이페이', '대북'] },
  { slug: 'kaohsiung', nameKo: '가오슝', iata: 'KHH', aliases: ['카오슝'] },
  { slug: 'taichung', nameKo: '타이중', iata: 'RMQ', aliases: [] },
  { slug: 'tainan', nameKo: '타이난', iata: 'TNN', aliases: [] },
  { slug: 'hualien', nameKo: '화롄', iata: 'HUN', aliases: ['화련'] },
  { slug: 'shanghai', nameKo: '상하이', iata: 'PVG', aliases: ['상해'] },
  { slug: 'beijing', nameKo: '베이징', iata: 'PEK', aliases: ['북경'] },
  { slug: 'qingdao', nameKo: '칭다오', iata: 'TAO', aliases: ['청도'] },
  { slug: 'shenzhen', nameKo: '선전', iata: 'SZX', aliases: ['심천'] },
  { slug: 'guangzhou', nameKo: '광저우', iata: 'CAN', aliases: ['광주시'] },
  { slug: 'xian', nameKo: '시안', iata: 'XIY', aliases: [] },
  { slug: 'chengdu', nameKo: '청두', iata: 'CTU', aliases: [] },
  { slug: 'hangzhou', nameKo: '항저우', iata: 'HGH', aliases: ['항주'] },
  { slug: 'nanjing', nameKo: '난징', iata: 'NKG', aliases: ['남경'] },
  { slug: 'chongqing', nameKo: '충칭', iata: 'CKG', aliases: [] },
  { slug: 'harbin', nameKo: '하얼빈', iata: 'HRB', aliases: [] },
  // ------------------------------------------------------------- 유럽 63
  { slug: 'paris', nameKo: '파리', iata: 'CDG', aliases: [] },
  { slug: 'nice', nameKo: '니스', iata: 'NCE', aliases: [] },
  { slug: 'lyon', nameKo: '리옹', iata: 'LYS', aliases: [] },
  { slug: 'marseille', nameKo: '마르세유', iata: 'MRS', aliases: [] },
  { slug: 'bordeaux', nameKo: '보르도', iata: 'BOD', aliases: [] },
  { slug: 'strasbourg', nameKo: '스트라스부르', iata: 'SXB', aliases: [] },
  { slug: 'london', nameKo: '런던', iata: 'LHR', aliases: [] },
  { slug: 'manchester', nameKo: '맨체스터', iata: 'MAN', aliases: [] },
  { slug: 'edinburgh', nameKo: '에든버러', iata: 'EDI', aliases: ['에딘버러'] },
  { slug: 'dublin', nameKo: '더블린', iata: 'DUB', aliases: [] },
  { slug: 'rome', nameKo: '로마', iata: 'FCO', aliases: ['roma'] },
  { slug: 'naples', nameKo: '나폴리', iata: 'NAP', aliases: [] },
  { slug: 'sicily', nameKo: '시칠리아', iata: 'CTA', aliases: ['시실리'] },
  { slug: 'pisa', nameKo: '피사', iata: 'PSA', aliases: [] },
  { slug: 'bologna', nameKo: '볼로냐', iata: 'BLQ', aliases: [] },
  { slug: 'verona', nameKo: '베로나', iata: 'VRN', aliases: [] },
  { slug: 'cinque-terre', nameKo: '친퀘테레', iata: null, aliases: ['친퀘테레'] },
  { slug: 'venice', nameKo: '베네치아', iata: 'VCE', aliases: ['베니스'] },
  { slug: 'florence', nameKo: '피렌체', iata: 'FLR', aliases: ['플로렌스'] },
  { slug: 'milan', nameKo: '밀라노', iata: 'MXP', aliases: ['밀란'] },
  { slug: 'barcelona', nameKo: '바르셀로나', iata: 'BCN', aliases: [] },
  { slug: 'madrid', nameKo: '마드리드', iata: 'MAD', aliases: [] },
  { slug: 'seville', nameKo: '세비야', iata: 'SVQ', aliases: [] },
  { slug: 'granada', nameKo: '그라나다', iata: 'GRX', aliases: [] },
  { slug: 'valencia', nameKo: '발렌시아', iata: 'VLC', aliases: [] },
  { slug: 'lisbon', nameKo: '리스본', iata: 'LIS', aliases: ['리스보아'] },
  { slug: 'porto', nameKo: '포르투', iata: 'OPO', aliases: [] },
  { slug: 'munich', nameKo: '뮌헨', iata: 'MUC', aliases: [] },
  { slug: 'berlin', nameKo: '베를린', iata: 'BER', aliases: [] },
  { slug: 'cologne', nameKo: '쾰른', iata: 'CGN', aliases: [] },
  { slug: 'frankfurt', nameKo: '프랑크푸르트', iata: 'FRA', aliases: [] },
  { slug: 'hamburg', nameKo: '함부르크', iata: 'HAM', aliases: [] },
  { slug: 'dresden', nameKo: '드레스덴', iata: 'DRS', aliases: [] },
  { slug: 'amsterdam', nameKo: '암스테르담', iata: 'AMS', aliases: ['암스텔담'] },
  { slug: 'brussels', nameKo: '브뤼셀', iata: 'BRU', aliases: [] },
  { slug: 'bruges', nameKo: '브뤼헤', iata: null, aliases: ['브뤼헤'] },
  { slug: 'luxembourg', nameKo: '룩셈부르크', iata: 'LUX', aliases: [] },
  { slug: 'zurich', nameKo: '취리히', iata: 'ZRH', aliases: ['쮜리히'] },
  { slug: 'interlaken', nameKo: '인터라켄', iata: null, aliases: [] },
  { slug: 'lucerne', nameKo: '루체른', iata: null, aliases: ['루쩨른'] },
  { slug: 'geneva', nameKo: '제네바', iata: 'GVA', aliases: [] },
  { slug: 'zermatt', nameKo: '체르마트', iata: null, aliases: ['마터호른'] },
  { slug: 'vienna', nameKo: '빈', iata: 'VIE', aliases: ['비엔나', 'wien'] },
  { slug: 'salzburg', nameKo: '잘츠부르크', iata: 'SZG', aliases: ['짤츠부르크'] },
  { slug: 'hallstatt', nameKo: '할슈타트', iata: null, aliases: [] },
  { slug: 'innsbruck', nameKo: '인스브루크', iata: 'INN', aliases: [] },
  { slug: 'prague', nameKo: '프라하', iata: 'PRG', aliases: ['praha'] },
  { slug: 'budapest', nameKo: '부다페스트', iata: 'BUD', aliases: [] },
  { slug: 'warsaw', nameKo: '바르샤바', iata: 'WAW', aliases: [] },
  { slug: 'krakow', nameKo: '크라쿠프', iata: 'KRK', aliases: ['크라코프'] },
  { slug: 'zagreb', nameKo: '자그레브', iata: 'ZAG', aliases: [] },
  { slug: 'dubrovnik', nameKo: '두브로브니크', iata: 'DBV', aliases: [] },
  { slug: 'athens', nameKo: '아테네', iata: 'ATH', aliases: [] },
  { slug: 'santorini', nameKo: '산토리니', iata: 'JTR', aliases: [] },
  { slug: 'mykonos', nameKo: '미코노스', iata: 'JMK', aliases: [] },
  { slug: 'malta', nameKo: '몰타', iata: 'MLA', aliases: [] },
  { slug: 'copenhagen', nameKo: '코펜하겐', iata: 'CPH', aliases: [] },
  { slug: 'stockholm', nameKo: '스톡홀름', iata: 'ARN', aliases: [] },
  { slug: 'oslo', nameKo: '오슬로', iata: 'OSL', aliases: [] },
  { slug: 'helsinki', nameKo: '헬싱키', iata: 'HEL', aliases: [] },
  { slug: 'reykjavik', nameKo: '레이캬비크', iata: 'KEF', aliases: ['레이캬빅'] },
  { slug: 'tallinn', nameKo: '탈린', iata: 'TLL', aliases: [] },
  { slug: 'moscow', nameKo: '모스크바', iata: 'SVO', aliases: [] },
  // ------------------------------------------------------------- 미주 34
  { slug: 'new-york', nameKo: '뉴욕', iata: 'JFK', aliases: [] },
  { slug: 'washington', nameKo: '워싱턴', iata: 'IAD', aliases: [] },
  { slug: 'boston', nameKo: '보스턴', iata: 'BOS', aliases: ['보스톤'] },
  { slug: 'philadelphia', nameKo: '필라델피아', iata: 'PHL', aliases: [] },
  { slug: 'chicago', nameKo: '시카고', iata: 'ORD', aliases: [] },
  { slug: 'atlanta', nameKo: '애틀랜타', iata: 'ATL', aliases: ['애틀란타'] },
  { slug: 'miami', nameKo: '마이애미', iata: 'MIA', aliases: [] },
  { slug: 'orlando', nameKo: '올랜도', iata: 'MCO', aliases: ['올란도'] },
  { slug: 'new-orleans', nameKo: '뉴올리언스', iata: 'MSY', aliases: [] },
  { slug: 'austin', nameKo: '오스틴', iata: 'AUS', aliases: [] },
  { slug: 'dallas', nameKo: '댈러스', iata: 'DFW', aliases: ['달라스'] },
  { slug: 'houston', nameKo: '휴스턴', iata: 'IAH', aliases: [] },
  { slug: 'denver', nameKo: '덴버', iata: 'DEN', aliases: [] },
  { slug: 'las-vegas', nameKo: '라스베이거스', iata: 'LAS', aliases: ['라스베가스'] },
  { slug: 'los-angeles', nameKo: '로스앤젤레스', iata: 'LAX', aliases: ['로스엔젤레스', '엘에이'] },
  { slug: 'san-diego', nameKo: '샌디에이고', iata: 'SAN', aliases: [] },
  { slug: 'san-francisco', nameKo: '샌프란시스코', iata: 'SFO', aliases: ['샌프란'] },
  { slug: 'seattle', nameKo: '시애틀', iata: 'SEA', aliases: [] },
  { slug: 'portland', nameKo: '포틀랜드', iata: 'PDX', aliases: [] },
  { slug: 'anchorage', nameKo: '앵커리지', iata: 'ANC', aliases: [] },
  { slug: 'vancouver', nameKo: '밴쿠버', iata: 'YVR', aliases: ['벤쿠버'] },
  { slug: 'toronto', nameKo: '토론토', iata: 'YYZ', aliases: [] },
  { slug: 'montreal', nameKo: '몬트리올', iata: 'YUL', aliases: [] },
  { slug: 'ottawa', nameKo: '오타와', iata: 'YOW', aliases: [] },
  { slug: 'calgary', nameKo: '캘거리', iata: 'YYC', aliases: ['켈거리'] },
  { slug: 'quebec', nameKo: '퀘벡', iata: 'YQB', aliases: [] },
  { slug: 'mexico-city', nameKo: '멕시코시티', iata: 'MEX', aliases: [] },
  { slug: 'cancun', nameKo: '칸쿤', iata: 'CUN', aliases: [] },
  { slug: 'lima', nameKo: '리마', iata: 'LIM', aliases: [] },
  { slug: 'cusco', nameKo: '쿠스코', iata: 'CUZ', aliases: [] },
  { slug: 'buenos-aires', nameKo: '부에노스아이레스', iata: 'EZE', aliases: [] },
  { slug: 'sao-paulo', nameKo: '상파울루', iata: 'GRU', aliases: ['상파울로'] },
  { slug: 'rio-de-janeiro', nameKo: '리우데자네이루', iata: 'GIG', aliases: ['리우'] },
  { slug: 'santiago', nameKo: '산티아고', iata: 'SCL', aliases: [] },
  // -------------------------------------------------------- 대양주·태평양 14
  { slug: 'guam', nameKo: '괌', iata: 'GUM', aliases: [] },
  { slug: 'saipan', nameKo: '사이판', iata: 'SPN', aliases: [] },
  { slug: 'hawaii', nameKo: '하와이', iata: 'HNL', aliases: ['호놀룰루'] },
  { slug: 'sydney', nameKo: '시드니', iata: 'SYD', aliases: [] },
  { slug: 'melbourne', nameKo: '멜버른', iata: 'MEL', aliases: ['멜번'] },
  { slug: 'brisbane', nameKo: '브리즈번', iata: 'BNE', aliases: [] },
  { slug: 'perth', nameKo: '퍼스', iata: 'PER', aliases: [] },
  { slug: 'cairns', nameKo: '케언스', iata: 'CNS', aliases: [] },
  { slug: 'gold-coast', nameKo: '골드코스트', iata: 'OOL', aliases: [] },
  { slug: 'adelaide', nameKo: '애들레이드', iata: 'ADL', aliases: [] },
  { slug: 'auckland', nameKo: '오클랜드', iata: 'AKL', aliases: [] },
  { slug: 'queenstown', nameKo: '퀸스타운', iata: 'ZQN', aliases: [] },
  { slug: 'christchurch', nameKo: '크라이스트처치', iata: 'CHC', aliases: ['크라이스트쳐치'] },
  { slug: 'wellington', nameKo: '웰링턴', iata: 'WLG', aliases: [] },
  // ----------------------------------------------------- 중동·아프리카·기타 14
  { slug: 'dubai', nameKo: '두바이', iata: 'DXB', aliases: [] },
  { slug: 'abu-dhabi', nameKo: '아부다비', iata: 'AUH', aliases: [] },
  { slug: 'doha', nameKo: '도하', iata: 'DOH', aliases: [] },
  { slug: 'tel-aviv', nameKo: '텔아비브', iata: 'TLV', aliases: [] },
  { slug: 'istanbul', nameKo: '이스탄불', iata: 'IST', aliases: [] },
  { slug: 'cairo', nameKo: '카이로', iata: 'CAI', aliases: [] },
  { slug: 'marrakesh', nameKo: '마라케시', iata: 'RAK', aliases: ['마라케쉬'] },
  { slug: 'delhi', nameKo: '델리', iata: 'DEL', aliases: ['뉴델리'] },
  { slug: 'mumbai', nameKo: '뭄바이', iata: 'BOM', aliases: [] },
  { slug: 'kathmandu', nameKo: '카트만두', iata: 'KTM', aliases: [] },
  { slug: 'colombo', nameKo: '콜롬보', iata: 'CMB', aliases: [] },
  { slug: 'maldives', nameKo: '몰디브', iata: 'MLE', aliases: [] },
  { slug: 'ulaanbaatar', nameKo: '울란바토르', iata: 'UBN', aliases: ['울란바타르'] },
  { slug: 'vladivostok', nameKo: '블라디보스토크', iata: 'VVO', aliases: ['블라디'] },
];

/** 별칭 → 도시. 키는 공백을 지우고 소문자로 맞춘 형태다. */
export const CITY_ALIASES: ReadonlyMap<string, CityEntry> = new Map(
  CITY_TABLE.flatMap((city) =>
    [
      city.slug,
      // 'new-york' 로는 "new york" 을 못 잡는다. 정규화가 공백만 지우기 때문이다.
      city.slug.replace(/-/g, ''),
      city.nameKo,
      ...city.aliases,
    ].map((alias) => [normalizeAlias(alias), city] as const),
  ),
);

/**
 * **도시 이름을 품고 있는 흔한 말들.** 문장 파서에서만 지운다.
 *
 * 도시 이름이 다른 단어 안에 통째로 들어앉아 있으면 최장 일치로도 못 막는다 —
 * 더 긴 별칭이 아예 없기 때문이다. 그래서 훑기 전에 이 말들을 먼저 지운다.
 *
 *   "세부 사항 알려줘"   → 세부(필리핀)
 *   "사파리 투어 있어?"  → **파리**(사파리 안에 들어 있다) · 사파
 *   "테니스 코트 있는"   → 니스
 *   "포르투갈 여행지"    → 포르투 (나라 이름이지 도시가 아니다)
 *
 * 엔티티로 온 값은 카카오가 도시로 확정한 것이라 여기 걸리지 않는다.
 */
const AMBIGUOUS: RegExp[] = [
  /세부\s*(사항|내용|정보|사양|항목|조건|일정)/g,
  /사파리/g,
  /테니스/g,
  /피사체/g,
  /포르투갈/g,
];

/**
 * 문장에서 긁으면 안 되는 별칭.
 *
 * 전부 도시 이름이면서 흔한 한국어이기도 하다. 문장 파서가 이걸 도시로 잡으면:
 *
 *   "빈 방 있는 호텔"      → 오스트리아 빈
 *   "어느 나라 가고 싶어"  → 일본 나라
 *   "퍼스트 클래스로"      → 호주 퍼스
 *   "사파리 투어 있어?"    → 베트남 사파
 *
 * 엔티티로 온 값은 카카오가 도시로 확정한 것이라 그대로 쓴다 — 막는 건 문장 경로뿐이다.
 * 대체 표기(비엔나 · vienna · nara · perth · sapa)는 그대로 인정한다.
 */
const UTTERANCE_UNSAFE = new Set(['빈', '나라', '퍼스', '사파']);

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

  const cleaned = AMBIGUOUS.reduce((text, trap) => text.replace(trap, ' '), utterance);
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

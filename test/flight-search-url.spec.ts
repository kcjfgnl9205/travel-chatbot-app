import {
  DEPART_AFTER_DAYS,
  RETURN_AFTER_DAYS,
  datedSearchUrl,
  seoulDate,
  tripCityCode,
} from '../src/modules/flight/search-url';

/**
 * 항공권 링크를 **검색된 상태**로 연다.
 *
 * 모델이 주는 건 빈 검색 폼(노선 페이지)이라, 카드에서 가격을 보고 누른 사람이
 * 날짜를 다시 입력해야 했다. 내일 출발·7일 뒤 귀국·1인으로 고정해서 결과를 바로 띄운다.
 *
 * ⚠️ **저장하면 안 되는 값이다.** 캐시는 날짜를 키에 넣지 않고 24시간 사니까
 *    (0004), 구워서 저장하면 내일 캐시를 맞은 사람이 어제 날짜를 받는다. 그래서
 *    `now` 를 인자로 받는다 — 테스트가 고정할 수 있다는 것이 곧 렌더 시점에
 *    만든다는 증거다.
 */

/** 2026-10-05 12:00 KST. */
const NOW = new Date('2026-10-05T03:00:00Z');

const SKY = { originCode: 'ICN', destCode: 'KIX', merchant: 'skyscanner' } as const;
const TRIP = { originCode: 'ICN', destCode: 'KIX', merchant: 'trip' } as const;
const MRT = { originCode: 'ICN', destCode: 'KIX', merchant: 'myrealtrip' } as const;

/**
 * ⚠️ **실제 검색 후 주소창에서 복사한 형식이다. 지어내지 않는다.**
 *
 * 한 번 당했다 — 스카이스캐너에 `adults=4`, 트립닷컴에 `quantity=4` 만 보냈더니
 * **둘 다 화면이 1명으로 열렸다.** 모르는 파라미터는 조용히 무시되기 때문이다.
 * 틀린 인원으로 검색된 페이지는 빈 폼보다 나쁘다 — 4명이 예약하려다 가격이
 * 달라서야 알아챈다. 마이리얼트립만 맞았는데, 그쪽만 주소창을 복사해 넣었었다.
 *
 * 그래서 **그때 복사한 주소의 파라미터를 여기 박아둔다.** 사이트 형식이 바뀌면
 * 이 테스트가 아니라 사람이 먼저 발견하겠지만, 적어도 "우리가 무엇을 보내기로
 * 했는지" 는 한 곳에 남는다.
 */
describe('실제 주소창에서 복사한 형식', () => {
  it('트립닷컴 — searchboxarg 가 빠지면 인원이 무시된다', () => {
    const url = new URL(datedSearchUrl({ ...TRIP, tripType: 'round' }, NOW, trip(4))!);

    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        'acity',
        'class',
        'curr',
        'dcity',
        'ddate',
        'locale',
        'lowpricesource',
        'nonstoponly',
        'quantity',
        'rdate',
        'searchboxarg',
        'triptype',
      ].sort(),
    );
    expect(url.searchParams.get('quantity')).toBe('4');
    expect(url.searchParams.get('searchboxarg')).toBe('t');
    expect(url.searchParams.get('lowpricesource')).toBe('searchform');
  });

  it('트립닷컴 — 공항이 아니라 도시 코드를 받는다', () => {
    const url = new URL(datedSearchUrl({ ...TRIP, tripType: 'round' }, NOW, trip(4))!);

    expect(url.searchParams.get('dcity')).toBe('sel');
    expect(url.searchParams.get('acity')).toBe('osa');
  });

  /**
   * 부산(PUS)·하노이(HAN)는 공항 코드와 도시 코드가 같다. **그래서 우연히 맞았고**,
   * 한동안 멀쩡해 보였다. 표에 없는 코드는 그대로 나가야 한다.
   */
  it('공항 코드가 곧 도시 코드인 곳은 그대로 둔다', () => {
    expect(tripCityCode('pus')).toBe('pus');
    expect(tripCityCode('han')).toBe('han');
    expect(tripCityCode('cju')).toBe('cju');
    expect(tripCityCode('icn')).toBe('sel');
    expect(tripCityCode('gmp')).toBe('sel');
    expect(tripCityCode('nrt')).toBe('tyo');
  });

  it('스카이스캐너 — adults 가 아니라 adultsv2 다', () => {
    const url = new URL(datedSearchUrl({ ...SKY, tripType: 'round' }, NOW, trip(4))!);

    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        'adultsv2',
        'cabinclass',
        'childrenv2',
        'inboundaltsenabled',
        'outboundaltsenabled',
        'preferdirects',
        'ref',
        'rtn',
      ].sort(),
    );
    expect(url.searchParams.get('adultsv2')).toBe('4');
    expect(url.searchParams.has('adults')).toBe(false);
  });

  it('편도는 스카이스캐너 rtn 이 0 이다', () => {
    const url = new URL(datedSearchUrl({ ...SKY, tripType: 'oneway' }, NOW, trip(4))!);

    expect(url.searchParams.get('rtn')).toBe('0');
    expect(url.pathname).toBe('/transport/flights/icn/kix/261006/');
  });
});

/** 인원 n 명만 말한 여행 조건. */
function trip(adults: number) {
  return { departDate: null, returnDate: null, nights: null, adults, used: [] };
}

describe('항공권 검색 주소', () => {
  it('스카이스캐너는 날짜를 경로에 YYMMDD 로 넣는다', () => {
    const url = datedSearchUrl({ ...SKY, tripType: 'round' }, NOW)!;

    expect(url).toContain('/transport/flights/icn/kix/261006/261013/');
    // ⚠️ `adults` 가 아니라 `adultsv2` 다. 이름이 틀리면 조용히 1명으로 열린다.
    expect(url).toContain('adultsv2=1');
    expect(url).toContain('cabinclass=economy');
    expect(url).toContain('rtn=1');
  });

  it('트립닷컴은 날짜를 쿼리로 넣는다', () => {
    const url = new URL(datedSearchUrl({ ...TRIP, tripType: 'round' }, NOW)!);

    expect(url.pathname).toBe('/flights/showfarefirst');
    // ⚠️ 공항(icn·kix)이 아니라 도시 코드(sel·osa)다. 공항 코드를 넣으면
    //    트립닷컴이 못 알아듣고 엉뚱한 노선을 연다 — 도쿄를 눌렀는데 부산이 떴다.
    expect(url.searchParams.get('dcity')).toBe('sel');
    expect(url.searchParams.get('acity')).toBe('osa');
    expect(url.searchParams.get('ddate')).toBe('2026-10-06');
    expect(url.searchParams.get('rdate')).toBe('2026-10-13');
    expect(url.searchParams.get('quantity')).toBe('1');
    expect(url.searchParams.get('triptype')).toBe('rt');
  });

  /** ⚠️ 빈 rdate 를 넣으면 왕복 폼이 열린다. 키 자체가 없어야 한다. */
  it('편도는 돌아오는 날을 아예 빼야 한다', () => {
    const trip = new URL(datedSearchUrl({ ...TRIP, tripType: 'oneway' }, NOW)!);
    expect(trip.searchParams.has('rdate')).toBe(false);
    expect(trip.searchParams.get('triptype')).toBe('ow');

    const sky = datedSearchUrl({ ...SKY, tripType: 'oneway' }, NOW)!;
    expect(sky).toContain('/icn/kix/261006/?');
    expect(sky).not.toContain('261013');
  });

  it('마이리얼트립은 구간을 trip 파라미터에 잇는다', () => {
    const url = new URL(
      datedSearchUrl(
        { ...MRT, tripType: 'round', originName: '서울', destName: '오사카' },
        NOW,
      )!,
    );

    // A=공항 C=도시. 우리는 IATA 공항 코드만 들고 있으므로 전부 A 다.
    expect(url.searchParams.get('trip')).toBe('A.ICN.A.KIX.2026-10-06/A.KIX.A.ICN.2026-10-13');
    expect(url.searchParams.get('adult')).toBe('1');
    expect(url.searchParams.get('tripType')).toBe('ROUND_TRIP');
    expect(url.searchParams.get('cityNames')).toBe('서울,오사카');
  });

  it('마이리얼트립 편도는 구간이 하나다', () => {
    const url = new URL(datedSearchUrl({ ...MRT, tripType: 'oneway' }, NOW)!);

    expect(url.searchParams.get('trip')).toBe('A.ICN.A.KIX.2026-10-06');
    expect(url.searchParams.get('tripType')).toBe('ONE_WAY');
  });

  /** 도시명은 화면 라벨이라 없어도 검색은 된다 — 빈 값을 넣지 말고 키를 뺀다. */
  it('도시명을 모르면 cityNames 를 아예 안 넣는다', () => {
    const url = new URL(datedSearchUrl({ ...MRT, tripType: 'round' }, NOW)!);

    expect(url.searchParams.has('cityNames')).toBe(false);
  });

  /**
   * ⚠️ **형식을 모르는 제휴몰은 건드리지 않는다.** 지어낸 주소로 바꾸는 것은
   *    빈 폼을 여는 것보다 나쁘다 — 404 로 떨어진다.
   */
  it('모르는 제휴몰이면 null — 호출부가 원본을 쓴다', () => {
    expect(datedSearchUrl({ ...TRIP, merchant: 'agoda', tripType: 'round' }, NOW)).toBeNull();
    expect(datedSearchUrl({ ...TRIP, merchant: null, tripType: 'round' }, NOW)).toBeNull();
  });

  it('공항 코드가 없으면 null — 노선을 특정할 수 없다', () => {
    expect(datedSearchUrl({ ...SKY, originCode: '', tripType: 'round' }, NOW)).toBeNull();
    expect(datedSearchUrl({ ...SKY, destCode: '서울', tripType: 'round' }, NOW)).toBeNull();
  });

  /**
   * ⚠️ **서버가 UTC 라도 사용자의 "오늘" 이어야 한다.** 한국 시간 09:00 이전에
   *    `new Date()` 를 그대로 쓰면 전날이 나와, 새벽에 물어본 사람에게 어제 출발하는
   *    항공권을 검색해 준다.
   */
  it('날짜는 한국 시간 기준이다', () => {
    // 2026-10-05 08:00 KST = 2026-10-04 23:00 UTC. UTC 로 읽으면 10/04 가 된다.
    const dawn = new Date('2026-10-04T23:00:00Z');

    expect(seoulDate(dawn)).toBe('2026-10-05');
    // 그 "오늘"(10/05)의 내일이 출발일이다.
    expect(datedSearchUrl({ ...SKY, tripType: 'round' }, dawn)).toContain('/261006/');
  });

  /**
   * ⚠️ **오늘이 아니라 내일 출발이다.** 오늘 떠나는 항공권은 대부분 이미 못 사거나
   *    당일 요금이라, 첫 줄이 카드 시세와 너무 벌어져 링크가 오히려 불신을 준다.
   */
  it('내일 출발, 거기서 7일 뒤 귀국', () => {
    expect(DEPART_AFTER_DAYS).toBe(1);
    expect(RETURN_AFTER_DAYS).toBe(7);
    expect(seoulDate(NOW, DEPART_AFTER_DAYS)).toBe('2026-10-06');
    expect(seoulDate(NOW, DEPART_AFTER_DAYS + RETURN_AFTER_DAYS)).toBe('2026-10-13');
  });
});

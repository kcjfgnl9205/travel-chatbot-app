import { resolveTrip } from '../src/modules/flight/search-url';
import { parseTripParams, withoutUsed } from '../src/modules/flight/trip-params';

/**
 * 발화에서 날짜·인원을 읽는다. **모델을 부르지 않는다.**
 *
 * 틀려도 손해가 작다는 게 전제다 — 우리가 여는 건 검색 폼이 채워진 페이지지 예약
 * 확정이 아니라서, 잘못 읽으면 사용자가 그 페이지에서 고친다. 아무것도 안 넣어
 * 내일 날짜로 여는 것보다는 낫다.
 */

/** 2026-10-14(수) 12:00 KST. 서버가 UTC 로 돌아도 서울의 '오늘' 이어야 한다. */
const NOW = new Date('2026-10-14T03:00:00Z');

const parse = (utterance: string) => parseTripParams(utterance, NOW);

describe('발화에서 날짜·인원 읽기', () => {
  it('범위를 출발일과 귀국일로 읽는다', () => {
    expect(parse('오사카 항공권 10/20~24 4명')).toMatchObject({
      departDate: '2026-10-20',
      returnDate: '2026-10-24',
      adults: 4,
    });
    expect(parse('오사카 항공권 10월 20일~24일')).toMatchObject({
      departDate: '2026-10-20',
      returnDate: '2026-10-24',
    });
  });

  it('달을 넘는 범위도 읽는다', () => {
    expect(parse('제주 10/30~2')).toMatchObject({
      departDate: '2026-10-30',
      returnDate: '2026-11-02',
    });
    expect(parse('제주 10월 30일~11월 2일')).toMatchObject({
      departDate: '2026-10-30',
      returnDate: '2026-11-02',
    });
  });

  // ⚠️ 날짜가 하나면 **출발일**이다. 귀국일만 말하는 사람은 드물다.
  it('날짜가 하나면 출발일이다', () => {
    expect(parse('제주 항공권 11월 3일')).toMatchObject({
      departDate: '2026-11-03',
      returnDate: null,
    });
  });

  it('나온 순서가 뜻을 가진다 — 앞이 출발일', () => {
    expect(parse('제주 11월 3일 가서 7일에 와')).toMatchObject({
      departDate: '2026-11-03',
      returnDate: '2026-11-07',
    });
  });

  it('지난 날짜는 내년으로 본다', () => {
    expect(parse('오사카 1/5 항공권')).toMatchObject({ departDate: '2027-01-05' });
  });

  it('일만 말하면 이번 달, 지났으면 다음 달', () => {
    expect(parse('제주 20일에 출발')).toMatchObject({ departDate: '2026-10-20' });
    expect(parse('제주 3일에 출발')).toMatchObject({ departDate: '2026-11-03' });
  });

  it('상대 날짜를 서울 기준으로 센다', () => {
    expect(parse('오사카 항공권 내일')).toMatchObject({ departDate: '2026-10-15' });
    expect(parse('오사카 항공권 모레')).toMatchObject({ departDate: '2026-10-16' });
    // 2026-10-14 는 수요일. 다가오는 토요일은 17일이다.
    expect(parse('오사카 이번 주말')).toMatchObject({ departDate: '2026-10-17' });
    expect(parse('오사카 다음 주말')).toMatchObject({ departDate: '2026-10-24' });
    // 다음 주 월요일.
    expect(parse('오사카 다음 주')).toMatchObject({ departDate: '2026-10-19' });
    expect(parse('오사카 다음 달')).toMatchObject({ departDate: '2026-11-01' });
  });

  it('요일도 읽는다', () => {
    expect(parse('오사카 금요일 출발')).toMatchObject({ departDate: '2026-10-16' });
    expect(parse('오사카 다음 주 금요일 출발')).toMatchObject({ departDate: '2026-10-23' });
  });

  // ⚠️ '3박 4일' 의 '4일' 을 날짜로 읽으면 11월 4일에 떠나는 항공권이 열린다.
  it('박수는 기간이지 날짜가 아니다', () => {
    expect(parse('다낭 3박 4일 3명')).toMatchObject({
      departDate: null,
      nights: 3,
      adults: 3,
    });
    expect(parse('다낭 11월 3일 3박 4일')).toMatchObject({
      departDate: '2026-11-03',
      nights: 3,
    });
  });

  it("'3일간' 은 기간이라 날짜로 읽지 않는다", () => {
    expect(parse('오사카 3일간 여행')).toMatchObject({ departDate: null });
  });

  it("'2인천' 같은 지명 조각을 인원으로 읽지 않는다", () => {
    expect(parse('인천에서 오사카 항공권')).toMatchObject({ adults: null });
    expect(parse('오사카 2인')).toMatchObject({ adults: 2 });
  });

  it('아무것도 없으면 전부 null 이다 — 기본값은 여기서 채우지 않는다', () => {
    expect(parse('오사카 항공권 찾아줘')).toEqual({
      departDate: null,
      returnDate: null,
      nights: null,
      adults: null,
      used: [],
    });
  });
});

describe('기본값 채우기', () => {
  it('아무것도 못 읽으면 내일 출발·7일 뒤 귀국·1인', () => {
    expect(resolveTrip('round', parse('오사카 항공권'), NOW)).toEqual({
      depart: '2026-10-15',
      back: '2026-10-22',
      adults: 1,
    });
  });

  it('편도는 귀국일이 없다', () => {
    expect(resolveTrip('oneway', parse('오사카 편도'), NOW).back).toBeNull();
  });

  // ⚠️ 귀국일은 **출발일로부터** 센다. 오늘로부터 세면 "다음 달 10일 출발" 이
  //    이미 지난 날짜로 돌아오는 일정이 된다.
  it('귀국일을 안 말했으면 출발일로부터 7일 뒤다', () => {
    expect(resolveTrip('round', parse('오사카 11월 20일'), NOW)).toMatchObject({
      depart: '2026-11-20',
      back: '2026-11-27',
    });
  });

  it('박수를 말했으면 그만큼 뒤다', () => {
    expect(resolveTrip('round', parse('다낭 11월 3일 3박 4일'), NOW)).toMatchObject({
      depart: '2026-11-03',
      back: '2026-11-06',
    });
  });
});

/**
 * ⚠️ **반영해놓고 "반영 안 됐어요" 라고 하면 안 된다.** 맞는 링크를 받고도 틀렸다고
 *    읽는다. 반대로 못 읽은 조건은 반드시 남아야 한다 — 고지 누락이 가장 나쁜 실패다.
 */
describe('고지에서 빼기', () => {
  it('반영한 표현만 뺀다', () => {
    const trip = parse('오사카 항공권 10/20~24 4명 아이랑');

    expect(withoutUsed(['10/20~24', '4명', '아이랑'], trip.used)).toEqual(['아이랑']);
  });

  /**
   * ⚠️ 두 파서가 같은 발화를 다르게 끊는다 — 고지용은 '다음 주' 까지만 보고 우리는
   *    '다음 주 금요일' 을 통째로 읽는다. 표기가 같을 때만 빼면 링크에는 금요일이
   *    들어간 채 "날짜는 반영되지 않았어요" 가 붙는다.
   */
  it('우리가 읽은 표현에 포함되면 뺀다', () => {
    const trip = parse('후쿠오카 항공권 다음 주 금요일');

    expect(withoutUsed(['다음 주'], trip.used)).toEqual([]);
  });

  it('못 읽은 조건은 남긴다', () => {
    const trip = parse('오사카 항공권 50만원대로');

    expect(withoutUsed(['50만원대'], trip.used)).toEqual(['50만원대']);
  });
});

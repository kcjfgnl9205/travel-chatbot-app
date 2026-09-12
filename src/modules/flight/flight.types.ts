import { CacheKeyPart } from '../search-cache/search-cache.service';
import * as t from '../kakao/templates';
import { TripType } from '../nlu/flight-nlu.service';

/**
 * provider 가 돌려주는 항공권 1건.
 *
 * 호텔(Hotel)과 나란히 두되 필드를 공유하지 않는다. 호텔은 "장소 하나"인데
 * 항공권은 "구간"이라, 억지로 한 타입에 넣으면 양쪽 다 optional 범벅이 된다.
 */
export interface Flight {
  /** 한국어 항공사명. 카드 첫 줄에 나간다. */
  airline: string;
  /** KE723 처럼. 여러 편이 묶인 경우 대표 편명. 모르면 null. */
  flightNo?: string | null;

  originCode: string; // ICN
  originName?: string | null; // 인천
  destCode: string; // KIX
  destName?: string | null; // 오사카

  /**
   * 출발/도착 시각. **HH:MM 문자열이다.**
   *
   * 왜 Date 가 아닌가 — 항공편 시각은 각 공항의 현지 시각이다. Date 로 만들면
   * 시간대를 붙여야 하는데 provider(모델)는 그걸 못 준다. 잘못된 시간대로 변환된
   * 시각을 보여주는 건 시각을 안 보여주는 것보다 나쁘다.
   */
  departTime?: string | null;
  arriveTime?: string | null;
  /** 가는 날 YYYY-MM-DD. 검색 날짜와 같지만 provider 가 다른 날을 줄 수도 있다. */
  departDate?: string | null;

  /** 돌아오는 편 (왕복일 때만). */
  returnDate?: string | null;
  returnDepartTime?: string | null;
  returnArriveTime?: string | null;

  /** 총 소요 시간(분). 편도 기준. */
  durationMinutes?: number | null;
  /** 경유 횟수. 0 이면 직항. */
  stops?: number | null;
  /** 경유지 공항/도시. 직항이면 null. */
  via?: string | null;

  tripType: TripType;
  cabin?: string | null;
  /** 1인 기준 총액(원). 왕복이면 왕복 합계. */
  priceFrom?: number | null;
  currency?: string;

  /**
   * 예약 페이지 주소. 애드픽 변환의 입력이고, 사용자가 실제로 이동하는 곳이다.
   *
   * ⚠️ 호텔과 달리 **여러 항공편이 같은 주소를 가리킬 수 있다** (같은 노선의
   *    검색 결과 페이지). 그래서 항공편의 신원으로는 쓸 수 없다 — dedupeKey 를 쓴다.
   */
  sourceUrl: string;
  merchant?: string | null; // trip | myrealtrip
  source?: string; // ai | crawler | manual
  tags?: string[];
  raw?: Record<string, unknown> | null;
}

export interface FlightQuery {
  originSlug: string;
  originName: string;
  originCode: string | null;
  destSlug: string;
  destName: string;
  destCode: string | null;
  departDate: string | null;
  returnDate: string | null;
  tripType: TripType;
  passengers: number | null;
  cabin: string | null;
  limit: number;
  /**
   * 출발지를 사용자가 말하지 않아서 기본값(서울)으로 채웠는가.
   *
   * 카드에 "서울 출발" 을 적어야 하는지 판단하는 데 쓴다. 사용자가 부산에서
   * 출발하려던 거라면 그 한 줄이 있어야 잘못됐다는 걸 알아챈다.
   */
  originAssumed: boolean;
}

/**
 * 캐시 키에 들어가는 조건들.
 *
 * ⚠️ **날짜가 반드시 들어가야 한다.** 빠지면 10월 3일을 물은 사람에게 9월 1일
 *    검색 결과가 나간다. 인원·좌석등급도 운임이 달라지므로 같이 넣는다.
 */
export function flightCacheKey(query: FlightQuery): CacheKeyPart[] {
  return [
    query.originCode ?? query.originSlug,
    query.destCode ?? query.destSlug,
    query.departDate,
    query.returnDate,
    query.tripType,
    query.passengers,
    query.cabin,
    query.limit,
  ];
}

/** 캐시에서 살려낸 값이 항공권 모양인가. 배포로 필드가 바뀌면 미스로 떨어뜨린다. */
export function isFlight(item: unknown): item is Flight {
  if (!item || typeof item !== 'object') return false;
  const f = item as Flight;
  return (
    typeof f.airline === 'string' &&
    typeof f.sourceUrl === 'string' &&
    typeof f.originCode === 'string' &&
    typeof f.destCode === 'string'
  );
}

/**
 * 같은 항공편인지 판정하는 키.
 *
 * sourceUrl 로는 못 한다 — 항공권은 여러 편이 같은 검색 결과 페이지를 가리키므로
 * 그걸로 중복을 지우면 카드가 한 장만 남는다. 편명 + 출발시각이 항공편의 신원이다.
 */
export function flightKey(f: Flight): string {
  return [
    f.flightNo?.toUpperCase() ?? f.airline,
    f.originCode,
    f.destCode,
    f.departDate ?? '',
    f.departTime ?? '',
  ].join('|');
}

// ------------------------------------------------------------------ 카드 문구
/** 122000 → '122,000원'. 값이 없으면 '가격 문의'. */
export function priceText(f: Flight): string {
  if (!f.priceFrom) return '가격 문의';
  return `${f.priceFrom.toLocaleString('ko-KR')}원`;
}

/** 145 → '2시간 25분'. 60분 미만이면 분만. */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

/** 0 → '직항', 1 → '1회 경유 (홍콩)'. */
export function stopsText(f: Flight): string {
  if (f.stops === 0) return '직항';
  if (!f.stops) return '';
  const label = `${f.stops}회 경유`;
  return f.via ? `${label} (${f.via})` : label;
}

/** '2시간 25분 · 직항'. 둘 다 없으면 빈 문자열. */
export function durationLine(f: Flight): string {
  const bits = [
    f.durationMinutes ? durationText(f.durationMinutes) : '',
    stopsText(f),
  ].filter(Boolean);
  return bits.join(' · ');
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * '2026-10-03' → '10/3(토)'. 카드 한 줄이 20자라 연도를 버린다.
 *
 * UTC 자정으로 파싱하고 getUTCDay() 를 쓴다. 날짜 문자열은 달력상의 날짜일 뿐
 * 시각이 아니므로, 지역 시간대로 파싱하면 서버가 어디에 떠 있는지에 따라
 * 요일이 하루씩 밀린다.
 */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  const [, month, day] = iso.split('-');
  return `${Number(month)}/${Number(day)}(${WEEKDAYS[parsed.getUTCDay()]})`;
}

/**
 * 한 구간을 카드 한 줄로. '10/3(금) 09:20→11:45'
 *
 * 20자 안에 날짜·출발·도착이 다 들어가야 해서 화살표 하나로 붙인다.
 * 시각을 모르면 날짜만, 날짜도 모르면 빈 문자열이 되고 그 줄은 빠진다.
 */
export function legText(
  date: string | null | undefined,
  depart: string | null | undefined,
  arrive: string | null | undefined,
): string {
  const times = [depart, arrive].filter(Boolean).join('→');
  return [dateLabel(date), times].filter(Boolean).join(' ');
}

/**
 * listCard 한 줄의 제목. '대한항공 KE723 · 325,000원'
 *
 * **가격을 제목에 둔다.** 항공편을 고르는 첫 번째 축이고, listCard 에서 제목이
 * 설명보다 눈에 먼저 들어온다. 40자까지 쓸 수 있어 자리도 넉넉하다.
 */
export function listRowTitle(f: Flight): string {
  const airline = [f.airline, f.flightNo].filter(Boolean).join(' ');
  return [airline, priceText(f)].filter(Boolean).join(' · ');
}

/**
 * listCard 한 줄의 설명. **40자 1줄**이라 itemCard 5줄이 담던 걸 다 못 넣는다.
 *
 *   편도: '10/3(토) 09:20→11:45 · 2시간 25분 · 직항'
 *   왕복: '10/3(토) 09:20 ↔ 10/7(수) 12:30 · 직항'
 *
 * 왕복은 두 구간의 날짜·출발 시각만으로 자리가 차서 **도착 시각과 소요 시간을 버린다.**
 * 대신 직항 여부는 남긴다 — 경유가 몇 번인지가 시각 다음으로 중요한 판단 기준이고,
 * 그건 예약 페이지를 열기 전에 알아야 거르기 때문이다.
 */
export function listRowDescription(f: Flight): string {
  const schedule =
    f.tripType === 'round'
      ? [departLabel(f.departDate, f.departTime), departLabel(f.returnDate, f.returnDepartTime)]
          .filter(Boolean)
          .join(' ↔ ')
      : legText(f.departDate, f.departTime, f.arriveTime);

  const tail = f.tripType === 'round' ? stopsText(f) : durationLine(f);
  return [schedule, tail].filter(Boolean).join(' · ');
}

/** '10/3(토) 09:20'. 왕복 한 구간을 날짜+출발시각으로만 줄인 것. */
function departLabel(
  date: string | null | undefined,
  depart: string | null | undefined,
): string {
  return [dateLabel(date), depart].filter(Boolean).join(' ');
}

/**
 * 카카오 itemCard 의 key-value 줄.
 *
 * ⚠️ **최대 5줄이고 key 는 6자까지다.** 왕복이면 항공사·가는편·오는편·소요로 4줄이 차므로
 *    여기에 더 넣을 자리가 거의 없다. 새 줄을 넣기 전에 무엇을 뺄지 먼저 정해야 한다.
 * ⚠️ 값이 빈 줄은 만들지 않는다. 카카오는 description 이 빈 항목을 받으면
 *    말풍선을 통째로 렌더링하지 않는다.
 */
export function cardRows(f: Flight): t.ItemRow[] {
  const rows: t.ItemRow[] = [];

  const airline = [f.airline, f.flightNo].filter(Boolean).join(' ');
  rows.push({ title: '항공사', description: airline });

  const outbound = legText(f.departDate, f.departTime, f.arriveTime);
  if (outbound) {
    rows.push({ title: f.tripType === 'round' ? '가는편' : '일정', description: outbound });
  }

  if (f.tripType === 'round') {
    const inbound = legText(f.returnDate, f.returnDepartTime, f.returnArriveTime);
    if (inbound) rows.push({ title: '오는편', description: inbound });
  }

  const duration = durationLine(f);
  if (duration) rows.push({ title: '소요', description: duration });

  // 남은 자리가 있으면 좌석 등급을 넣는다. 없으면 조용히 버린다 —
  // 5줄을 넘기면 카드가 아예 안 보이므로, 있으면 좋은 정보에 그 위험을 걸지 않는다.
  if (f.cabin && rows.length < t.MAX_ITEM_LIST_ROWS) {
    rows.push({ title: '좌석', description: cabinText(f.cabin) });
  }

  return rows;
}

const CABINS: Record<string, string> = {
  economy: '이코노미',
  premium: '프리미엄 이코노미',
  business: '비즈니스',
  first: '일등석',
};

export function cabinText(cabin: string): string {
  return CABINS[cabin.toLowerCase()] ?? cabin;
}

export interface FlightProvider {
  readonly name: string;
  /**
   * ⚠️ 느릴 수 있다(AI provider 는 7~30초). 호출부는 반드시 백그라운드에서만 부른다.
   * 카카오 5초 예산 안에서 도는 건 캐시 조회뿐이다.
   */
  search(query: FlightQuery): Promise<Flight[]>;
}

/**
 * provider DI 토큰.
 *
 * 구현을 직접 주입하지 않는 이유: 테스트에서 가짜 provider 로 갈아끼워야 하고
 * (실제 OpenAI 를 부르면 안 된다), FLIGHT_PROVIDER 설정으로도 바뀐다.
 */
export const FLIGHT_PROVIDER = 'FLIGHT_PROVIDER';

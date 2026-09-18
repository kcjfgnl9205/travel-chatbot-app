import { Logger } from '@nestjs/common';

/**
 * 같은 항목이 리스트에 두 번 나가지 않게 한다.
 *
 * **무엇이 "같은 항목" 인지는 도메인마다 다르다.** 그래서 키 함수를 받는다 —
 * 세 도메인이 서로 다른 이유로 서로 다른 값을 쓴다.
 *
 *   · 호텔   예약 주소. AI 는 같은 호텔을 이름만 다르게 여러 번 준다
 *            ('호텔 그란비아 오사카' / 'Hotel Granvia Osaka'). 이름은 못 믿는다.
 *   · 항공권 편명+시각. 주소로 판정하면 **줄이 한 줄만 남는다** — 여러 편이 같은
 *            노선 검색 페이지를 가리키기 때문이다.
 *   · 관광지 지도 링크. 이름을 정규화해 만든 값이라 표기 흔들림을 흡수하고,
 *            무엇보다 **사용자가 도착하는 곳**이 같으면 같은 관광지다.
 *
 * ⚠️ **저장하기 전에 부른다.** 저장 후에 지우면 20건이 페이지마다 줄어들고,
 *    2페이지에 1페이지에서 이미 본 항목이 다시 나온다.
 */
export function dedupeBy<T>(
  items: T[],
  opts: {
    /** 로그에 찍는 도메인 이름. 'hotel' | 'flight' | 'attraction' */
    label: string;
    keyOf: (item: T) => string;
    /** 로그용 표시 이름. 어떤 항목이 겹쳤는지 눈으로 봐야 할 때가 있다. */
    nameOf: (item: T) => string;
    logger?: Logger;
  },
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const key = opts.keyOf(item);
    if (seen.has(key)) {
      opts.logger?.log(`duplicate ${opts.label} dropped: ${opts.nameOf(item)} (${key})`);
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

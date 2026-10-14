import { FlightOffer, FlightQuery } from './flight.types';
import { datedSearchUrl } from './search-url';

/**
 * 검색 없이 만드는 항공권 카드.
 *
 * **항공권은 검색할 필요가 없다.** 모델에게 7~30초·요금을 들여 물어봐도 줄 링크는
 * 어차피 우리가 IATA 코드로 조립한다 ([search-url.ts](./search-url.ts)) — 모델이
 * 주는 주소는 빈 검색 폼이라 쓰지 않기 때문이다. 모델이 실제로 사오는 건 카드 한 줄의
 * **시세·소요시간·항공사**뿐이고, 그중 변하는 건 시세 하나인데 그마저 "웹에서 본 값의
 * 폭" 이라 확정 운임이 아니라고 고지하고 나간다.
 *
 * 그 한 줄을 포기하고 얻는 것:
 *
 *   · **즉답.** 카카오 5초 예산 안에서 끝나 "찾고 있어요" 말풍선과 콜백이 사라진다.
 *   · **요금 0원.** 단톡방에서 같은 질문이 몇 번 날아와도 공짜다.
 *   · **빈손이 없다.** 모델이 이유 없이 빈손으로 돌아오던 실패 모드가 사라진다.
 *   · **날짜·인원을 반영할 수 있다.** 캐시를 노선으로 가를 이유 자체가 없어진다.
 *
 * 잃는 것은 **플랫폼별 가격 비교**다. 작지 않다 — 어디가 싼지가 줄을 고르는 기준이었다.
 * 시세를 미리 채워두는 표(배치)를 나중에 얹으면 이 줄 위에 숫자만 올라온다.
 *
 * ⚠️ **여기서 지어내지 마라.** 가격·소요시간·항공사는 조사해야 아는 값이라 비워 둔다.
 *    비어 있으면 카드는 플랫폼 설명 한 줄을 쓴다(merchantTagline). 모르는 것을
 *    그럴듯하게 채우는 건 느린 것보다 나쁘다.
 */

/**
 * 줄로 낼 플랫폼. **순서가 카드 순서다.**
 *
 * ⚠️ 스카이스캐너는 애드픽 광고주가 없어 수익이 나지 않는다. 그래도 남기는 이유는
 *    메타서치라 비교 폭이 넓어서다 — 수익 안 나는 줄 하나보다 줄이 둘뿐인 카드가 나쁘다.
 *    같은 판단이 [openai.provider.ts](./providers/openai.provider.ts) 에도 적혀 있다.
 */
export const LINK_MERCHANTS = ['trip', 'skyscanner', 'myrealtrip'] as const;

/**
 * 노선 하나 → 플랫폼별 줄.
 *
 * 주소는 여기서도 만들지만 **카드를 그릴 때 다시 만든다**([flight.service.ts](./flight.service.ts)
 * rows). 저장된 주소에는 날짜가 박혀 있고 행은 캐시에 남기 때문이다(0004). 여기 값은
 * 줄의 신원(offerKey)과 제휴 변환의 입력으로 쓰인다.
 */
export function linkOffers(query: FlightQuery, now: Date = new Date()): FlightOffer[] {
  const offers: FlightOffer[] = [];
  for (const merchant of LINK_MERCHANTS) {
    const sourceUrl = datedSearchUrl(
      {
        originCode: query.originCode ?? '',
        destCode: query.destCode ?? '',
        tripType: query.tripType,
        merchant,
        originName: query.originName,
        destName: query.destName,
      },
      now,
    );
    // 공항 코드를 모르는 지역이다 (교토·강릉). 노선을 특정할 수 없으니 줄을 안 만든다 —
    // 빈 폼으로 보내느니 카드가 비는 편이 낫고, 그때는 "못 찾았어요" 가 나간다.
    if (!sourceUrl) continue;
    offers.push({
      merchant,
      sourceUrl,
      originCode: query.originCode ?? '',
      destCode: query.destCode ?? '',
      originName: query.originName,
      destName: query.destName,
      tripType: query.tripType,
    });
  }
  return offers.slice(0, query.limit);
}

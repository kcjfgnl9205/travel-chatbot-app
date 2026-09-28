import { Inject, Injectable, Logger } from '@nestjs/common';

import { clip, text } from '../../common/parse';
import { AppConfig, CONFIG } from '../../config/app.config';
import { AttractionsRepository } from '../database/repositories/attractions.repository';
import { OpenAiService, parseJsonLoose } from '../openai/openai.service';

/**
 * **아무도 안 넣은 도시를 모델이 채운다.**
 *
 * 0009 는 관광지를 전부 사람이 넣는 구조였다. 깨끗하지만 도시 237곳을 손으로
 * 채우는 건 현실적이지 않고, 안 넣은 도시는 빈손이었다.
 *
 * ⚠️ **0008 이전으로 돌아가는 게 아니다.** 그때(`b87194a` 에서 되돌린 판)는 모델
 *    출력이 사용자에게 **바로** 갔다. 폐관한 곳이 섞여도 DB 에 남지 않으니 아무도
 *    모르고, 다음 사람에게 또 같은 거짓말이 나갔다.
 *
 *    지금은 DB 를 거친다. 그 차이가 셋이다 —
 *
 *      · 한 번만 부른다. 같은 도시를 백 명이 물어도 모델은 한 번이다
 *      · `source='ai'` 로 표시돼서 **나중에 훑어 고칠 수 있다**
 *      · 관리 화면에서 한 줄만 지우면 그걸로 끝난다
 *
 * ⚠️ **웹 검색을 쓰지 않는다.** `web_search` 는 $10/1,000회 + 검색 본문 토큰이라
 *    도시 하나에 $0.05~0.1 인데, 학습 지식만 쓰면 $0.002 다. 유명 관광지는 모델이
 *    이미 알고 있어서 차이가 그만큼 나지 않는다 — 대신 **최근에 생긴 곳은 모른다.**
 *
 * ⚠️ **사진은 채우지 않는다.** 모델에게 이미지 주소를 시키면 그럴듯한 CDN 주소를
 *    지어낸다(호텔에서 확인된 것 — `web_search` 는 텍스트만 준다). 사진 없는 줄로
 *    나가고, 운영이 나중에 관리 화면에서 넣는다.
 */

const INSTRUCTIONS = [
  '너는 한국인 여행자를 위한 관광지 목록을 만드는 어시스턴트다.',
  '주어진 도시에서 처음 가는 한국인 여행자가 갈 만한 곳을 추천 순서대로 JSON 으로만 답한다.',
  // 순서를 따로 시키지 않으면 유명세와 무관하게 섞여 나온다.
  '가장 유명하고 누구나 가는 곳을 앞에 둔다.',
  '**카테고리를 섞어라.** 명소·자연·쇼핑·박물관이 고루 들어가게 한다.',
  // 이게 없으면 "오사카성" 대신 "오사카 성 공원 근처 산책로" 같은 게 나온다.
  'name 은 한국인이 검색할 법한 표준 표기로 쓴다 (오사카성, 도톤보리).',
  'area 는 그 도시 안에서의 위치다 (주오구, 난바). 도시 이름을 다시 쓰지 않는다.',
  '⚠️ **확실하지 않으면 넣지 마라.** 폐업·폐관했거나 존재가 불확실한 곳은 빼라.',
  '⚠️ **요청한 개수를 억지로 채우지 마라.** 확실한 곳이 적으면 적게 내는 편이 낫다.',
  '인사말·서론·설명을 쓰지 말고 결과 JSON 만 낸다.',
].join(' ');

export const BACKFILL_SCHEMA = {
  type: 'json_schema' as const,
  name: 'city_attractions',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['attractions'],
    properties: {
      attractions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'area'],
          properties: {
            name: { type: 'string', description: '관광지 표준 한국어 표기' },
            area: {
              type: ['string', 'null'],
              description: '도시 안에서의 위치 (주오구, 난바). 모르면 null',
            },
          },
        },
      },
    },
  },
};

/** 로그에 남길 모델 원문 길이. */
const LOG_TEXT = 200;

export interface BackfillResult {
  /** DB 에 실제로 들어간 수. 유니크 충돌로 빠진 것은 제외된다. */
  inserted: number;
  /** 모델이 제안한 수. inserted 와 벌어지면 중복이 많았다는 뜻이다. */
  proposed: number;
}

@Injectable()
export class AttractionBackfillService {
  private readonly logger = new Logger(AttractionBackfillService.name);

  /**
   * 지금 같은 도시를 채우고 있는 중인가.
   *
   * ⚠️ **프로세스 안 잠금이다.** 검색 쪽 선점(`search_results` pending)이 이미 한 겹
   *    막아주지만, 그건 캐시 키 단위라 "같은 도시를 다른 경로로 동시에" 는 못 막는다.
   *    모델 호출이 곧 요금이라 한 겹 더 둔다.
   */
  private readonly filling = new Set<number>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly openai: OpenAiService,
    private readonly attractions: AttractionsRepository,
  ) {}

  /** 끌 수 있다. 끄면 빈 도시는 빈 채로 남는다 (0009 의 동작). */
  get enabled(): boolean {
    return this.config.attractionBackfill && this.openai.enabled && this.attractions.enabled;
  }

  /**
   * 도시 하나를 채운다. **이미 뭔가 들어 있으면 아무것도 하지 않는다.**
   *
   * ⚠️ 사람이 넣은 목록을 모델이 덮어쓰면 안 된다. 호출부가 "비었더라" 를 보고
   *    부르지만, 그 사이에 누가 넣었을 수 있으므로 여기서 다시 본다.
   */
  async fill(cityId: number, cityName: string): Promise<BackfillResult> {
    const none: BackfillResult = { inserted: 0, proposed: 0 };
    if (!this.enabled) return none;

    // 같은 도시를 두 번 사지 않는다.
    if (this.filling.has(cityId)) {
      this.logger.log(`backfill already running city=${cityName}`);
      return none;
    }
    this.filling.add(cityId);

    try {
      const existing = await this.attractions.listByCity(cityId);
      if (existing === null) {
        // DB 를 못 믿는 상태다. 모델을 부르면 그 결과를 저장도 못 한다.
        this.logger.warn(`backfill skipped, db unavailable city=${cityName}`);
        return none;
      }
      if (existing.length) {
        this.logger.log(`backfill skipped, already filled city=${cityName} rows=${existing.length}`);
        return none;
      }

      const proposed = await this.ask(cityName);
      if (!proposed.length) return none;

      const inserted = await this.attractions.insertMany(
        cityId,
        proposed.map((p, rank) => ({ ...p, rank })),
      );
      this.logger.log(
        `backfill city=${cityName} proposed=${proposed.length} inserted=${inserted}`,
      );
      return { inserted, proposed: proposed.length };
    } finally {
      this.filling.delete(cityId);
    }
  }

  // ---------------------------------------------------------------- 내부
  /** 모델에게 목록을 받는다. 실패하면 빈 배열 — 도시는 빈 채로 남는다. */
  private async ask(cityName: string): Promise<{ name: string; area: string | null }[]> {
    try {
      const result = await this.openai.respond({
        instructions: INSTRUCTIONS,
        input: `도시: ${cityName}\n추천할 관광지 수: ${this.config.attractionBackfillCount}곳`,
        effort: this.config.openaiRankEffort,
        format: BACKFILL_SCHEMA,
      });

      const parsed = parseJsonLoose<{ attractions?: unknown }>(result.text);
      const rows = Array.isArray(parsed?.attractions) ? parsed.attractions : [];
      const out = toProposals(rows, this.config.attractionBackfillCount);

      if (!out.length) {
        this.logger.warn(
          `backfill produced nothing city=${cityName} text=${clip(result.text, LOG_TEXT)}`,
        );
      }
      return out;
    } catch (err) {
      // 채우지 못해도 사용자는 "정리하지 못했어요" 를 받는다. 다음 질문에 다시 시도한다.
      this.logger.warn(`backfill failed city=${cityName} err=${err}`);
      return [];
    }
  }
}

/**
 * 모델 응답 → 넣을 행.
 *
 * ⚠️ **이름이 같은 것을 여기서 거른다.** DB 유니크 인덱스가 막아주긴 하지만, 충돌이
 *    나면 그 insert 만 실패하는 게 아니라 **배열 전체가 실패한다**(단일 statement).
 *    모델이 "오사카성" 과 "오사카 성" 을 같이 내는 일이 있어서 먼저 접는다.
 */
export function toProposals(
  rows: unknown[],
  limit: number,
): { name: string; area: string | null }[] {
  const out: { name: string; area: string | null }[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    const row = raw as { name?: unknown; area?: unknown } | null;
    const name = text(row?.name);
    if (!name) continue;

    // 띄어쓰기·문장부호 차이를 지워서 견준다 ('오사카성' = '오사카 성').
    const key = name.replace(/[\s·・\-–—()[\],.'"`’]/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, area: text(row?.area) });
    if (out.length >= limit) break;
  }
  return out;
}

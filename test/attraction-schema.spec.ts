import {
  ATTRACTION_CANDIDATE_SCHEMA,
  ATTRACTION_SCHEMA,
} from '../src/modules/attraction/providers/openai.provider';

/**
 * 1차·2차 스키마가 어긋나지 않는지 본다.
 *
 * **이 파일이 막는 사고는 조용하다.** 1차 스키마에 없는 필드는 2차가 절대 못 채우는데
 * (2차는 "후보에 없는 건 null" 규칙을 지킨다), 그렇게 비는 칸은 에러를 내지 않고
 * 그냥 항상 null 로 나간다. duration_minutes 와 호텔 썸네일이 실제로 그랬다 —
 * 배포 후에 카드를 눈으로 보고서야 알았다.
 *
 * 그래서 "두 스키마의 모양이 같은가" 를 여기서 기계가 본다.
 */

interface ItemSchema {
  required: string[];
  properties: Record<string, { type: unknown; enum?: unknown; description?: unknown }>;
}

/** 스키마는 OpenAI 에 그대로 실려 가는 값이라 타입을 느슨하게 두고 여기서만 좁힌다. */
function itemsOf(schema: unknown, key: string): ItemSchema {
  const { properties } = (
    schema as { schema: { properties: Record<string, { items: ItemSchema }> } }
  ).schema;
  return properties[key].items;
}

const candidate = itemsOf(ATTRACTION_CANDIDATE_SCHEMA, 'candidates');
const pick = itemsOf(ATTRACTION_SCHEMA, 'attractions');

/** 한쪽에만 있어도 되는 필드. 1차의 메모와, 2차가 고른 뒤에야 쓰는 값들이다. */
const STAGE_ONLY = ['note', 'description', 'tags'];

describe('관광지 스키마', () => {
  it('공유 필드가 양쪽에 다 있다', () => {
    const shared = candidate.required.filter((name) => !STAGE_ONLY.includes(name));
    for (const name of shared) {
      expect(pick.properties[name]).toBeDefined();
    }
    // 2차에만 몰래 생긴 필드도 없어야 한다 — 그것 역시 영원히 null 이 되는 칸이다.
    const pickShared = pick.required.filter((name) => !STAGE_ONLY.includes(name));
    expect(pickShared.sort()).toEqual(shared.sort());
  });

  it('공유 필드의 type·enum 이 두 호출에서 같다', () => {
    for (const name of candidate.required.filter((n) => !STAGE_ONLY.includes(n))) {
      expect({ name, ...typeOf(candidate.properties[name]) }).toEqual({
        name,
        ...typeOf(pick.properties[name]),
      });
    }
  });

  /**
   * 실제로 비어 나갔던 필드들. 이름을 박아두는 이유는, 위 두 테스트가 "양쪽이 같다" 만
   * 보기 때문이다 — 양쪽에서 같이 사라지면 통과한다.
   */
  it('사고가 났던 필드가 아직 있다', () => {
    for (const name of ['name_en', 'duration_minutes', 'admission_currency']) {
      expect(candidate.required).toContain(name);
      expect(pick.required).toContain(name);
    }
  });

  /** strict 모드는 모든 키가 required 여야 한다. 빠지면 OpenAI 가 400 을 준다. */
  it('strict 라 모든 키가 required 다', () => {
    for (const schema of [candidate, pick]) {
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    }
  });
});

/** 설명은 단계마다 다르게 쓴다. 비교에서 빼는 건 그래서다. */
function typeOf(field: { type: unknown; enum?: unknown }): { type: unknown; enum: unknown } {
  return { type: field.type, enum: field.enum ?? null };
}

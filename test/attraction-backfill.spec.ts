import { AttractionBackfillService, toProposals } from '../src/modules/attraction/attraction-backfill';
import { loadConfig } from '../src/config/app.config';

/**
 * 빈 도시를 모델이 채우는 단계.
 *
 * ⚠️ **`b87194a` 에서 되돌렸던 구조와 한 끗 차이다.** 그때는 모델 출력이 사용자에게
 *    바로 갔다. 지금은 DB 를 거치므로 (1) 도시당 한 번만 부르고 (2) `source='ai'` 로
 *    표시돼 나중에 고칠 수 있고 (3) 사람이 넣은 것을 덮지 않는다.
 *    이 파일이 지키는 게 그 셋이다.
 */

function build(
  over: {
    reply?: string;
    existing?: Record<string, any>[] | null;
    enabled?: boolean;
    dbEnabled?: boolean;
    backfill?: boolean;
  } = {},
) {
  const asked: string[] = [];
  const inserted: { cityId: number; items: any[] }[] = [];

  const openai = {
    enabled: over.enabled ?? true,
    respond: async (req: { input: string }) => {
      asked.push(req.input);
      return { text: over.reply ?? '{"attractions":[{"name":"오사카성","area":"주오구"}]}', ms: 1 };
    },
  } as never;

  const attractions = {
    enabled: over.dbEnabled ?? true,
    listByCity: async () => ('existing' in over ? over.existing : []),
    insertMany: async (cityId: number, items: any[]) => {
      inserted.push({ cityId, items });
      return items.length;
    },
  } as never;

  const config = { ...loadConfig(), attractionBackfill: over.backfill ?? true } as never;

  return { service: new AttractionBackfillService(config, openai, attractions, noImages), asked, inserted };
}

/** 사진 탐색은 여기 관심사가 아니다 — 목록을 채우는 것만 본다. */
const noImages = { fillCity: async () => ({ filled: 0, missing: 0 }) } as never;

describe('켜고 끄기', () => {
  it('끄면 아무것도 안 한다', async () => {
    const { service, asked } = build({ backfill: false });

    expect(service.enabled).toBe(false);
    expect(await service.fill(1, '오사카')).toEqual({ inserted: 0, proposed: 0 });
    expect(asked).toEqual([]);
  });

  it('OpenAI 키가 없으면 꺼진다', () => {
    expect(build({ enabled: false }).service.enabled).toBe(false);
  });

  it('DB 가 없으면 꺼진다 — 채워도 저장할 곳이 없다', () => {
    expect(build({ dbEnabled: false }).service.enabled).toBe(false);
  });
});

describe('사람이 넣은 것을 덮지 않는다', () => {
  /**
   * ⚠️ 호출부가 "비었더라" 를 보고 부르지만, 그 사이에 누가 넣었을 수 있다.
   *    여기서 다시 보지 않으면 관리 화면에서 공들여 정리한 목록 위에 모델이 덮는다.
   */
  it('이미 뭔가 있으면 모델을 안 부른다', async () => {
    const { service, asked, inserted } = build({ existing: [{ id: 1, name: '오사카성' }] });

    expect(await service.fill(1, '오사카')).toEqual({ inserted: 0, proposed: 0 });
    expect(asked).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it('DB 를 못 읽으면 모델을 안 부른다 — 저장도 못 할 결과를 사지 않는다', async () => {
    const { service, asked } = build({ existing: null });

    await service.fill(1, '오사카');

    expect(asked).toEqual([]);
  });
});

describe('채우기', () => {
  it('도시 이름과 개수를 넘기고 결과를 넣는다', async () => {
    const { service, asked, inserted } = build({
      reply: '{"attractions":[{"name":"오사카성","area":"주오구"},{"name":"도톤보리","area":"난바"}]}',
    });

    const result = await service.fill(42, '오사카');

    expect(asked[0]).toContain('오사카');
    expect(result).toEqual({ inserted: 2, proposed: 2 });
    expect(inserted[0].cityId).toBe(42);
    expect(inserted[0].items).toEqual([
      { name: '오사카성', area: '주오구', nameEn: null, rank: 0 },
      { name: '도톤보리', area: '난바', nameEn: null, rank: 1 },
    ]);
  });

  it('모델 순서가 곧 rank 다', async () => {
    const { service, inserted } = build({
      reply: '{"attractions":[{"name":"가","area":null},{"name":"나","area":null},{"name":"다","area":null}]}',
    });

    await service.fill(1, '오사카');

    expect(inserted[0].items.map((i: any) => i.rank)).toEqual([0, 1, 2]);
  });

  it('모델이 터져도 조용히 넘어간다 — 도시는 빈 채로 남는다', async () => {
    const openai = {
      enabled: true,
      respond: async () => {
        throw new Error('OpenAI 폭발');
      },
    } as never;
    const attractions = { enabled: true, listByCity: async () => [], insertMany: async () => 0 } as never;
    const service = new AttractionBackfillService(loadConfig(), openai, attractions, noImages);

    await expect(service.fill(1, '오사카')).resolves.toEqual({ inserted: 0, proposed: 0 });
  });

  it('JSON 이 깨져도 조용히 넘어간다', async () => {
    const { service, inserted } = build({ reply: '이건 JSON 이 아니다' });

    expect(await service.fill(1, '오사카')).toEqual({ inserted: 0, proposed: 0 });
    expect(inserted).toEqual([]);
  });

  /** 모델 호출이 곧 요금이다. 같은 도시를 두 번 사지 않는다. */
  it('같은 도시를 동시에 부르면 한 번만 산다', async () => {
    const { service, asked } = build();

    await Promise.all([service.fill(1, '오사카'), service.fill(1, '오사카')]);

    expect(asked).toHaveLength(1);
  });
});

describe('모델 응답 다듬기', () => {
  /**
   * ⚠️ **이름 중복을 먼저 접어야 한다.** DB 유니크 인덱스에 걸리면 그 행만 빠지는 게
   *    아니라 insert 배열 전체가 실패한다. 모델이 '오사카성' 과 '오사카 성' 을 같이
   *    내는 일이 실제로 있다.
   */
  it('표기만 다른 중복을 접는다', () => {
    expect(
      toProposals(
        [{ name: '오사카성' }, { name: '오사카 성' }, { name: '도톤보리' }],
        20,
      ).map((p) => p.name),
    ).toEqual(['오사카성', '도톤보리']);
  });

  it('이름이 없는 줄은 버린다', () => {
    expect(toProposals([{ name: '  ' }, { area: '주오구' }, { name: '오사카성' }], 20)).toEqual([
      { name: '오사카성', area: null, nameEn: null },
    ]);
  });

  it('요청한 개수에서 끊는다', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ name: `곳${i}` }));
    expect(toProposals(rows, 20)).toHaveLength(20);
  });

  it('area 는 없어도 된다', () => {
    expect(toProposals([{ name: '오사카성', area: null, nameEn: null }], 20)).toEqual([
      { name: '오사카성', area: null, nameEn: null },
    ]);
  });
});

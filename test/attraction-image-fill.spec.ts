import { AttractionImageService } from '../src/modules/attraction/attraction-image.service';

/**
 * 사진 채우기.
 *
 * ⚠️ **사람이 넣은 사진을 덮지 않는 것**이 이 파일이 지키는 전부다. 운영이 골라둔
 *    사진이 자동 탐색으로 되돌아가면, 고쳐놓은 것이 다시 틀어진다.
 */

function build(
  rows: Record<string, unknown>[] | null,
  opts: { images?: boolean } = {},
) {
  const updates: { id: number; patch: Record<string, unknown> }[] = [];
  const attractions = {
    enabled: true,
    listByCity: async () => rows,
    update: async (id: number, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      return { id };
    },
  } as never;
  const config = {
    attractionImages: opts.images ?? true,
    attractionImageTimeoutMs: 50,
  } as never;
  return { updates, service: new AttractionImageService(config, attractions) };
}

/** 위키미디어를 실제로 안 친다 — 첫 응답에서 쓸 만한 사진을 준다. */
function stubWiki(thumb: string | null) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        thumb
          ? { query: { pages: { 1: { title: '오사카성', index: 1, thumbnail: { source: thumb } } } } }
          : {},
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
  return () => {
    globalThis.fetch = original;
  };
}

const PHOTO = 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Osaka_Castle.jpg';

describe('사진 채우기', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it('사진이 빈 곳만 채운다 — 사람이 넣은 것은 안 건드린다', async () => {
    restore = stubWiki(PHOTO);
    const { service, updates } = build([
      { id: 1, name: '오사카성', image_url: null },
      { id: 2, name: '도톤보리', image_url: 'https://사람이/넣은.jpg' },
    ]);

    const result = await service.fillCity(42, '오사카', 'osaka');

    expect(updates.map((u) => u.id)).toEqual([1]);
    expect(result.filled).toBe(1);
  });

  /** ⚠️ 저작자 표시의 유일한 단서다. 예전에 이 탐색을 걷어낸 이유 중 하나였다. */
  it('사진과 함께 출처 문서 주소를 남긴다', async () => {
    restore = stubWiki(PHOTO);
    const { service, updates } = build([{ id: 1, name: '오사카성', image_url: null }]);

    await service.fillCity(42, '오사카', 'osaka');

    expect(updates[0].patch.image_url).toBe(PHOTO);
    expect(String(updates[0].patch.image_source)).toMatch(/^https:\/\/(ko|en|commons)\./);
  });

  it('못 찾으면 아무것도 쓰지 않는다 — 그 줄은 사진 없이 나간다', async () => {
    restore = stubWiki(null);
    const { service, updates } = build([{ id: 1, name: '없는곳', image_url: null }]);

    const result = await service.fillCity(42, '오사카', 'osaka');

    expect(updates).toEqual([]);
    expect(result).toEqual({ filled: 0, missing: 1 });
  });

  it('꺼두면 아무것도 안 한다', async () => {
    restore = stubWiki(PHOTO);
    const { service, updates } = build([{ id: 1, name: '오사카성', image_url: null }], {
      images: false,
    });

    await service.fillCity(42, '오사카', 'osaka');

    expect(updates).toEqual([]);
  });

  it('DB 를 못 읽으면 조용히 넘어간다', async () => {
    restore = stubWiki(PHOTO);
    const { service, updates } = build(null);

    expect(await service.fillCity(42, '오사카', 'osaka')).toEqual({ filled: 0, missing: 0 });
    expect(updates).toEqual([]);
  });

  /** 위키미디어가 흔들려도 목록은 이미 있다. 사진만 비면 된다. */
  it('탐색이 터져도 도시 전체가 실패하지 않는다', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('위키미디어 폭발');
    });
    restore = () => {
      globalThis.fetch = original;
    };
    const { service } = build([{ id: 1, name: '오사카성', image_url: null }]);

    expect(await service.fillCity(42, '오사카', 'osaka')).toEqual({ filled: 0, missing: 1 });
  });
});

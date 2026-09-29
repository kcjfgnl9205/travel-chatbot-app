import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { AttractionAdminController } from '../src/modules/attraction/attraction-admin.controller';
import { Place } from '../src/modules/places/places.types';

/**
 * 관광지 관리 API.
 *
 * **0009 에서 목록의 출처가 사람이 됐다.** 구글이 주던 것을 이제 운영자가 넣으므로,
 * 여기서 막지 못한 잘못된 값은 그대로 카드에 나간다. 그래서 검사가 이 컨트롤러의
 * 절반이다.
 */

const TOKEN = 'test-token';

const OSAKA: Place = {
  id: 42,
  canonicalName: '오사카',
  slug: 'osaka',
  kind: 'city',
  countryCode: 'JP',
  iata: 'KIX',
  parentId: null,
};

function build(
  over: {
    create?: (input: any) => Promise<any>;
    update?: (id: number, patch: any) => Promise<any>;
    remove?: (id: number) => Promise<any[] | null>;
    list?: () => Promise<any[] | null>;
    reorder?: (ids: number[]) => Promise<number>;
    resolve?: (raw: string) => Promise<Place | null>;
    token?: string;
  } = {},
) {
  const patches: { id: number; patch: Record<string, unknown> }[] = [];
  const attractions = {
    listByCity: over.list ?? (async () => []),
    create: over.create ?? (async (i: any) => ({ id: 1, ...toRow(i) })),
    update:
      over.update ??
      (async (id: number, patch: any) => {
        patches.push({ id, patch });
        return { id, name: '오사카성', area: '주오구', image_url: null, rank: 0 };
      }),
    remove: over.remove ?? (async () => [{ id: 1 }]),
    reorder: over.reorder ?? (async (ids: number[]) => ids.length),
  } as never;
  const places = { resolve: over.resolve ?? (async () => OSAKA) } as never;
  const config = { debugToken: 'token' in over ? over.token : TOKEN } as never;
  const filled: { cityId: number; cityName: string; cityNameEn: string }[] = [];
  const images = {
    fillCity: async (cityId: number, cityName: string, cityNameEn: string) => {
      filled.push({ cityId, cityName, cityNameEn });
      return { filled: 3, missing: 1 };
    },
  } as never;

  return {
    controller: new AttractionAdminController(config, attractions, places, images),
    patches,
    filled,
  };
}

function toRow(i: any) {
  return { city_id: i.cityId, name: i.name, area: i.area, image_url: i.imageUrl, rank: i.rank };
}

describe('인증', () => {
  it('토큰이 틀리면 401', async () => {
    const { controller } = build();
    await expect(controller.list('오사카', '틀린토큰')).rejects.toThrow(UnauthorizedException);
  });

  it('토큰이 없으면 401', async () => {
    const { controller } = build();
    await expect(controller.list('오사카', undefined)).rejects.toThrow(UnauthorizedException);
  });

  /**
   * ⚠️ DEBUG_TOKEN 을 안 정한 서버에 관리 API 가 열려 있는 것보다 없는 게 낫다.
   *    404 인 이유는 존재 자체를 알리지 않으려는 것이다 (진단 경로와 같은 규칙).
   */
  it('DEBUG_TOKEN 을 안 정했으면 404 — 경로가 아예 없는 것처럼', async () => {
    const { controller } = build({ token: '' });
    await expect(controller.list('오사카', TOKEN)).rejects.toThrow(NotFoundException);
  });
});

describe('등록', () => {
  it('도시를 해석해서 city_id 로 넣는다', async () => {
    const created: any[] = [];
    const { controller } = build({
      create: async (i) => {
        created.push(i);
        return { id: 1, ...toRow(i) };
      },
    });

    const res = await controller.create(
      { city: '오사카', name: '오사카성', area: '주오구', imageUrl: 'https://cdn/a.jpg' },
      TOKEN,
    );

    expect(created[0]).toEqual({
      cityId: 42,
      name: '오사카성',
      // 카드에는 안 나간다 — 사진을 찾을 때만 쓰는 값이라 안 주면 null 이다.
      nameEn: null,
      area: '주오구',
      imageUrl: 'https://cdn/a.jpg',
      rank: 0,
    });
    expect(res).toEqual({
      id: 1,
      name: '오사카성',
      area: '주오구',
      imageUrl: 'https://cdn/a.jpg',
      rank: 0,
      // 관리 화면에서 넣은 것이므로 manual. 모델이 채운 행과 갈라 보여야 한다.
      source: 'manual',
    });
  });

  it('이름이 비면 막는다 — 제목 없는 카드 줄은 쓸 수 없다', async () => {
    const { controller } = build();
    await expect(
      controller.create({ city: '오사카', name: '   ' }, TOKEN),
    ).rejects.toThrow(BadRequestException);
  });

  it('도시를 못 알아보면 막는다', async () => {
    const { controller } = build({ resolve: async () => null });
    await expect(
      controller.create({ city: '없는곳', name: '오사카성' }, TOKEN),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * ⚠️ **카카오는 http 이미지를 조용히 안 그린다.** 통과시키면 운영자는 "왜 사진이
   *    안 나오지" 를 카드를 보고서야 알게 된다. 넣는 자리에서 막는 게 맞다.
   */
  it('http 사진을 막는다', async () => {
    const { controller } = build();
    await expect(
      controller.create({ city: '오사카', name: '오사카성', imageUrl: 'http://cdn/a.jpg' }, TOKEN),
    ).rejects.toThrow(/https/);
  });

  it('사진은 없어도 된다', async () => {
    const { controller } = build();
    const res: any = await controller.create({ city: '오사카', name: '오사카성' }, TOKEN);
    expect(res.imageUrl).toBeNull();
  });

  /** DB 유니크 인덱스(city_id, name)가 막으면 저장소가 null 을 준다. */
  it('같은 이름이 이미 있으면 400', async () => {
    const { controller } = build({ create: async () => null });
    await expect(
      controller.create({ city: '오사카', name: '오사카성' }, TOKEN),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('수정', () => {
  /**
   * ⚠️ **undefined 와 null 을 갈라야 한다.** 한데 묶으면 이름만 고치려던 요청이
   *    사진을 지운다 — 관리 도구에서 가장 조용하고 나쁜 사고다.
   */
  it('안 준 칸은 안 건드린다', async () => {
    const { controller, patches } = build();

    await controller.update(7, { name: '새 이름' }, TOKEN);

    expect(patches[0].patch).toEqual({ name: '새 이름' });
    expect(patches[0].patch).not.toHaveProperty('image_url');
    expect(patches[0].patch).not.toHaveProperty('area');
  });

  it('null 을 주면 비운다', async () => {
    const { controller, patches } = build();

    await controller.update(7, { area: null, imageUrl: null }, TOKEN);

    expect(patches[0].patch).toEqual({ area: null, image_url: null });
  });

  it('이름을 빈 값으로 못 바꾼다', async () => {
    const { controller } = build();
    await expect(controller.update(7, { name: '  ' }, TOKEN)).rejects.toThrow(BadRequestException);
  });

  it('고칠 칸이 하나도 없으면 막는다', async () => {
    const { controller } = build();
    await expect(controller.update(7, {}, TOKEN)).rejects.toThrow(BadRequestException);
  });

  it('없는 id 면 404', async () => {
    const { controller } = build({ update: async () => null });
    await expect(controller.update(99, { name: 'x' }, TOKEN)).rejects.toThrow(NotFoundException);
  });

  it('rank 0 도 고쳐진다 — falsy 라고 빠지면 맨 앞으로 못 옮긴다', async () => {
    const { controller, patches } = build();

    await controller.update(7, { rank: 0 }, TOKEN);

    expect(patches[0].patch).toEqual({ rank: 0 });
  });
});

describe('삭제', () => {
  it('지운 수를 돌려준다', async () => {
    const { controller } = build();
    expect(await controller.remove(7, TOKEN)).toEqual({ deleted: 1 });
  });

  it('없는 id 면 404', async () => {
    const { controller } = build({ remove: async () => [] });
    await expect(controller.remove(99, TOKEN)).rejects.toThrow(NotFoundException);
  });

  it('DB 가 꺼져 있으면 400 — 지웠다고 거짓말하지 않는다', async () => {
    const { controller } = build({ remove: async () => null });
    await expect(controller.remove(7, TOKEN)).rejects.toThrow(BadRequestException);
  });
});

describe('순서', () => {
  it('배열 위치가 곧 rank 다', async () => {
    let got: number[] = [];
    const { controller } = build({
      reorder: async (ids) => {
        got = ids;
        return ids.length;
      },
    });

    expect(await controller.reorder({ ids: [12, 9, 31] }, TOKEN)).toEqual({ moved: 3 });
    expect(got).toEqual([12, 9, 31]);
  });

  it('빈 목록은 막는다', async () => {
    const { controller } = build();
    await expect(controller.reorder({ ids: [] }, TOKEN)).rejects.toThrow(BadRequestException);
  });
});

describe('목록', () => {
  it('snake_case 를 밖으로 내보내지 않는다', async () => {
    const { controller } = build({
      list: async () => [
        {
          id: 1,
          city_id: 42,
          name: '오사카성',
          area: '주오구',
          image_url: 'https://c/a.jpg',
          rank: 0,
          source: 'ai',
        },
      ],
    });

    const res = await controller.list('오사카', TOKEN);

    expect(res.city).toBe('오사카');
    expect(res.items).toEqual([
      { id: 1, name: '오사카성', area: '주오구', imageUrl: 'https://c/a.jpg', rank: 0, source: 'ai' },
    ]);
  });

  /** 모델이 채운 것만 훑어보는 검수 경로. */
  it('source=ai 를 저장소에 그대로 넘긴다', async () => {
    const seen: (string | undefined)[] = [];
    const attractions = {
      listByCity: async (_id: number, source?: string) => {
        seen.push(source);
        return [];
      },
    } as never;
    const places = { resolve: async () => OSAKA } as never;
    const config = { debugToken: TOKEN } as never;
    const images = { fillCity: async () => ({ filled: 0, missing: 0 }) } as never;
    const controller = new AttractionAdminController(config, attractions, places, images);

    await controller.list('오사카', TOKEN, 'ai');
    await controller.list('오사카', TOKEN, '이상한값');
    await controller.list('오사카', TOKEN);

    // 아는 값만 넘긴다 — 모르는 값을 그대로 넘기면 조용히 빈 목록이 된다.
    expect(seen).toEqual(['ai', undefined, undefined]);
  });

  it('DB 가 꺼져 있으면 빈 목록', async () => {
    const { controller } = build({ list: async () => null });
    expect((await controller.list('오사카', TOKEN)).items).toEqual([]);
  });
});

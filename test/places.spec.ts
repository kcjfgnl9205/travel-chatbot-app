import { Test } from '@nestjs/testing';

import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/modules/database/database.module';
import { OpenAiService } from '../src/modules/openai/openai.service';
import { PlacesModule } from '../src/modules/places/places.module';
import { PlacesService } from '../src/modules/places/places.service';
import { usableCityNames } from '../src/modules/places/places.service';
import { aliasKey, slugOf } from '../src/modules/places/places.types';
import { FakeOpenAiService } from './fake-openai';

describe('별칭 정규화', () => {
  it('공백과 대소문자를 지운다 — 표기가 갈리면 캐시도 갈린다', () => {
    expect(aliasKey(' 오사카 ')).toBe('오사카');
    expect(aliasKey('New York')).toBe('newyork');
    expect(aliasKey('OSAKA')).toBe('osaka');
  });

  it('슬러그는 소문자·하이픈이다', () => {
    expect(slugOf('New York')).toBe('new-york');
    expect(slugOf('Osaka!')).toBe('osaka');
  });
});

describe('PlacesService', () => {
  let places: PlacesService;
  let openai: FakeOpenAiService;

  beforeEach(async () => {
    openai = new FakeOpenAiService();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, PlacesModule],
    })
      .overrideProvider(OpenAiService)
      .useValue(openai)
      .compile();

    places = moduleRef.get(PlacesService);
    places.clearMemory();
  });

  it('사전에 있는 도시는 모델 없이 해석한다 (공항 코드까지)', async () => {
    const place = await places.resolve('오사카');

    expect(place).toMatchObject({ canonicalName: '오사카', slug: 'osaka', iata: 'KIX' });
    expect(openai.calls).toHaveLength(0);
  });

  it('다른 표기도 같은 place 로 모인다 — 이게 곧 캐시 적중률이다', async () => {
    const a = await places.resolve('동경');
    const b = await places.resolve('도쿄');
    const c = await places.resolve('Tokyo');

    expect(a!.id).toBe(b!.id);
    expect(b!.id).toBe(c!.id);
  });

  it('같은 지명을 두 번 물어도 모델은 한 번만 부른다', async () => {
    await places.resolve('도톤보리');
    await places.resolve('도톤보리');

    expect(openai.calls).toHaveLength(1);
  });

  it('세부 지역은 자기 place 를 갖고 부모 도시에 매달린다', async () => {
    const place = await places.resolve('도톤보리');
    const parent = await places.parentOf(place!);

    // ⚠️ 오사카의 별칭으로 합치면 "도톤보리 주변" 이라는 정보가 사라진다.
    expect(place).toMatchObject({ canonicalName: '도톤보리', slug: 'dotonbori', kind: 'area' });
    expect(parent).toMatchObject({ canonicalName: '오사카', slug: 'osaka' });
  });

  it('모델도 모르는 지명은 원문 그대로 등록한다 — 되묻지 않는다', async () => {
    const place = await places.resolve('뭔가이상한동네');

    // 검증하지 않는 게 규칙이다. 정말 없는 곳이면 검색 결과가 비는 것으로 드러난다.
    expect(place).toMatchObject({ canonicalName: '뭔가이상한동네', kind: 'area' });
  });

  it('모델이 뻗어도 해석을 포기하지 않는다', async () => {
    openai.failNext = true;

    const place = await places.resolve('시부야');

    expect(place?.canonicalName).toBe('시부야');
  });

  it('빈 문자열은 지역이 아니다', async () => {
    expect(await places.resolve('  ')).toBeNull();
  });
});

describe('나라 되묻기용 도시 이름', () => {
  it('한글이 아니거나 라벨이 잘릴 이름은 버린다', () => {
    // ⚠️ 실제로 "Santiago de C…" 로 잘린 퀵리플라이가 나갔다. 누를 마음이 안 든다.
    expect(usableCityNames(['바르셀로나', 'Santiago de Compostela', '마드리드'])).toEqual([
      '바르셀로나',
      '마드리드',
    ]);
    expect(usableCityNames(['산티아고데콤포스텔라'])).toEqual([]);
  });

  it('중복을 지우고 8곳까지만 남긴다 — 퀵리플라이 10칸에서 한 자리는 "다른 도시" 가 쓴다', () => {
    const names = usableCityNames([
      '다낭', '다낭', '하노이', '호치민', '나트랑', '하롱', '후에', '사파', '달랏', '푸꾸옥',
    ]);
    expect(names).toHaveLength(8);
    expect(names[0]).toBe('다낭');
  });
});

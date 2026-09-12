import {
  isUsableImage,
  normalizeTitle,
  pickImage,
  searchUrl,
  titleMatches,
} from '../src/modules/attraction/attraction-image';

/**
 * 관광지 대표 이미지 고르기.
 *
 * 이 파일이 지키는 건 하나다 — **엉뚱한 사진을 내보내지 않는 것.**
 * 사진이 없는 줄은 그냥 밋밋하지만, 틀린 사진은 사용자가 그 장소인 줄 안다.
 * 아래 케이스는 전부 실제 위키백과 응답에서 나온 것들이다.
 */
describe('관광지 대표 이미지', () => {
  const thumb = (file: string) =>
    `https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/${file}/960px-${file}`;

  describe('문서가 그 관광지가 맞는가', () => {
    it('부분 이름도 인정한다 — 문서 제목이 더 길거나 짧을 수 있다', () => {
      expect(titleMatches('천문시계', '프라하 천문시계', '프라하')).toBe(true);
      expect(titleMatches('다이아몬드 헤드', '다이아몬드헤드산', '하와이')).toBe(true);
      expect(titleMatches('와이키키 해변', '와이키키', '하와이')).toBe(true);
      expect(titleMatches('오사카성', '오사카성', '오사카')).toBe(true);
    });

    it('⚠️ 그럴듯하게 다른 곳을 거른다 — 실제로 물고 온 것들', () => {
      // 검색이 "유니버설 스튜디오 재팬" 으로 싱가포르 문서를 물고 왔다.
      // 글자 겹침 같은 느슨한 규칙을 쓰면 이게 통과한다.
      expect(
        titleMatches('유니버설 스튜디오 재팬', '유니버설 스튜디오 싱가포르', '오사카'),
      ).toBe(false);
      expect(titleMatches('톱스 힐', '제시카 에니스힐', '세부')).toBe(false);
      expect(titleMatches('시밀란', '푸껫주', '세부')).toBe(false);
    });

    it('도시 문서 자체는 관광지 사진이 아니다', () => {
      // 검색이 관광지를 못 찾으면 도시 문서로 떨어진다. 그 문서의 대표 이미지는
      // 대개 위치 지도라, 통과시키면 카드에 지도가 박힌다.
      expect(titleMatches('미케 비치', '다낭', '다낭')).toBe(false);
      expect(titleMatches('마젤란 십자가', '세부', '세부')).toBe(false);
    });

    it('표기 차이는 흡수한다', () => {
      expect(normalizeTitle('바츨라프 광장')).toBe(normalizeTitle('바츨라프광장'));
      expect(normalizeTitle("Magellan's Cross")).toBe(normalizeTitle('Magellans Cross'));
    });
  });

  describe('사진으로 쓸 수 있는 주소인가', () => {
    it('평범한 사진은 받는다', () => {
      expect(isUsableImage(thumb('Osaka_Castle_02bs3200.jpg'))).toBe(true);
      expect(isUsableImage(thumb('Dotombori_neon_signs.JPG'))).toBe(true);
    });

    it('⚠️ 위치 지도를 거른다 — 세부에서 실제로 이게 왔다', () => {
      expect(
        isUsableImage(
          'https://upload.wikimedia.org/wikipedia/commons/e/e8/Ph_locator_cebu_cebu.png',
        ),
      ).toBe(false);
    });

    it('도표·문장·로고를 거른다', () => {
      for (const file of [
        'Flag_of_Japan.png',
        'Coat_of_arms_of_Prague.png',
        'Seal_of_Osaka.png',
        'Wikivoyage-Logo.png',
        'Location_map_Thailand.png',
      ]) {
        expect(isUsableImage(`https://upload.wikimedia.org/wikipedia/commons/a/a1/${file}`)).toBe(
          false,
        );
      }
    });

    it('SVG 는 받지 않는다 — 위키백과에서는 사실상 전부 도표다', () => {
      expect(
        isUsableImage('https://upload.wikimedia.org/wikipedia/commons/a/a1/Diagram.svg'),
      ).toBe(false);
    });

    it('http 는 받지 않는다 — 카카오 카드가 막는다', () => {
      expect(isUsableImage('http://upload.wikimedia.org/a/Osaka_Castle.jpg')).toBe(false);
      expect(isUsableImage('그냥 문자열')).toBe(false);
    });
  });

  describe('검색 결과에서 한 장 고르기', () => {
    const page = (index: number, title: string, file: string) => ({
      index,
      title,
      thumbnail: { source: thumb(file) },
    });

    it('위키백과가 매긴 순위대로 본다', () => {
      const found = pickImage(
        [page(2, '오사카부', 'Osaka_Prefecture.jpg'), page(1, '오사카성', 'Osaka_Castle.jpg')],
        '오사카성',
        '오사카',
      );
      expect(found?.title).toBe('오사카성');
    });

    it('1순위가 걸리면 다음 후보로 넘어간다', () => {
      const found = pickImage(
        [
          { index: 1, title: '세부', thumbnail: { source: thumb('Ph_locator_cebu.png') } },
          page(2, '산페드로 요새', 'Fort_San_Pedro.jpg'),
        ],
        '산페드로 요새',
        '세부',
      );
      expect(found?.title).toBe('산페드로 요새');
    });

    it('쓸 만한 게 없으면 null — 아무거나 내보내지 않는다', () => {
      expect(pickImage([page(1, '푸껫주', 'Phuket.jpg')], '시밀란', '세부')).toBeNull();
      expect(pickImage([{ index: 1, title: '오사카성' }], '오사카성', '오사카')).toBeNull();
      expect(pickImage([], '오사카성', '오사카')).toBeNull();
    });

    it('추적 파라미터를 뗀다 — 같은 사진이 매번 다른 주소가 되면 안 된다', () => {
      const found = pickImage(
        [
          {
            index: 1,
            title: '오사카성',
            thumbnail: { source: `${thumb('Osaka_Castle.jpg')}?utm_source=ko.wikipedia.org` },
          },
        ],
        '오사카성',
        '오사카',
      );
      expect(found?.url).not.toContain('utm_source');
    });
  });

  describe('질의 주소', () => {
    it('도시를 같이 넣는다 — "중앙공원" 은 전 세계에 있다', () => {
      const url = new URL(searchUrl('ko', '중앙공원', '오사카'));
      expect(url.host).toBe('ko.wikipedia.org');
      expect(url.searchParams.get('gsrsearch')).toBe('중앙공원 오사카');
      expect(url.searchParams.get('prop')).toBe('pageimages');
    });

    it('언어판이 주소에 반영된다', () => {
      expect(new URL(searchUrl('en', 'Kawasan Falls', 'Cebu')).host).toBe('en.wikipedia.org');
    });
  });
});

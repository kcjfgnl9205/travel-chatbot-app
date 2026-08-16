import { hasCity, parse } from '../src/nlu/nlu';

describe('발화 파싱', () => {
  it.each([
    ['오사카 호텔 추천해줘', 'osaka'],
    ['도쿄 숙소 알려줘', 'tokyo'],
    ['동경 호텔', 'tokyo'],
    ['fukuoka hotel', 'fukuoka'],
    ['大阪 호텔', 'osaka'],
    ['호텔 추천', null],
  ])('%s → %s', (text, expected) => {
    expect(parse(text).citySlug).toBe(expected);
  });

  it('인원·박수도 뽑는다', () => {
    const parsed = parse('오사카 2박 3명 호텔');
    expect(parsed.guests).toBe(3);
    expect(parsed.nights).toBe(2);
  });

  it('엔티티 파라미터가 발화보다 우선한다', () => {
    expect(parse('호텔 추천', '후쿠오카').citySlug).toBe('fukuoka');
    expect(hasCity(parse('호텔 추천'))).toBe(false);
  });
});

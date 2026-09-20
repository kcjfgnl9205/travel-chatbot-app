import { durationText } from '../src/common/duration';

/**
 * 항공권(비행 시간)과 관광지(관람 시간)가 같은 함수를 쓴다. 예전에는 사본이 한 벌씩
 * 있었고 테스트도 도메인 스펙마다 하나씩 있었다 — 같은 걸 두 번 검증하면서도
 * 한쪽만 고쳐지면 갈라지는 자리였다.
 */
describe('durationText', () => {
  it('시간과 분으로 끊는다', () => {
    expect(durationText(145)).toBe('2시간 25분');
    expect(durationText(150)).toBe('2시간 30분');
  });

  it('분이 0이면 시간만', () => {
    expect(durationText(120)).toBe('2시간');
  });

  it('60분 미만이면 분만', () => {
    expect(durationText(45)).toBe('45분');
  });
});

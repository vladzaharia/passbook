import { describe, expect, it } from 'vitest';
import { hasUndrawable, needsFallback } from './pdf-coverage.ts';

describe('hasUndrawable', () => {
  it.each(['Ada Lovelace', 'Žofia Łukasz', 'Иван Петров', 'ｆｕｌｌ', '€ 5 – 10'])(
    'passes %s',
    (text) => expect(hasUndrawable({ holder: text })).toBe(false),
  );
  it.each(['李雷', 'שלום', '😀'])('flags %s, also nested', (text) => {
    expect(hasUndrawable(text)).toBe(true);
    expect(hasUndrawable({ rows: [{ value: text }] })).toBe(true);
  });
  it('ignores non-text values', () =>
    expect(hasUndrawable({ n: 3, ok: true, x: null })).toBe(false));

  it.each([
    ['Vietnamese', 'Nguyễn Thị Hương', false],
    ['Greek', 'Αλέξανδρος Παπαδόπουλος', false],
    ['Cyrillic', 'Иван Петров', false],
    ['CJK', '李雷', true],
    ['Hebrew', 'שלום', true],
    ['Arabic', 'مرحبا', true],
    ['emoji', '😀', true],
  ])('%s: lossy is %s', (_script, text, lossy) => {
    expect(hasUndrawable({ holder: text })).toBe(lossy);
  });
  it('asks for the fallback only when Rubik lacks a character', () => {
    expect(needsFallback({ a: ['Nguyễn'] })).toBe(true);
    expect(needsFallback('Αλέξανδρος')).toBe(true);
    expect(needsFallback('Zoë Łukasz Иван')).toBe(false);
    expect(needsFallback('李雷')).toBe(false);
  });
});

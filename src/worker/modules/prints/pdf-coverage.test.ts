import { describe, expect, it } from 'vitest';
import { hasUndrawable } from './pdf-coverage.ts';

describe('hasUndrawable', () => {
  it.each(['Ada Lovelace', 'Žofia Łukasz', 'Иван Петров', 'ｆｕｌｌ', '€ 5 – 10'])(
    'passes %s',
    (text) => expect(hasUndrawable({ holder: text })).toBe(false),
  );
  it.each(['Nguyễn Thị Hương', '李雷', 'שלום', '😀'])('flags %s, also nested', (text) => {
    expect(hasUndrawable(text)).toBe(true);
    expect(hasUndrawable({ rows: [{ value: text }] })).toBe(true);
  });
  it('ignores non-text values', () =>
    expect(hasUndrawable({ n: 3, ok: true, x: null })).toBe(false));
});

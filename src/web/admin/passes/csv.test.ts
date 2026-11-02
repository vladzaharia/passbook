import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.ts';

describe('toCsv', () => {
  it('joins rows with CRLF and quotes commas, quotes and line breaks', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', 'say "hi"'],
          ['line\nbreak', 'plain'],
        ],
      ),
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",plain');
  });

  it.each(['=SUM(A1)', '+1', '-2', '@cmd', '\tx', '\rx'])(
    'defuses the formula cell %j',
    (value) => {
      const csv = toCsv(['h'], [[value]]);
      const cell = csv.split('\r\n')[1] ?? '';
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('leaves ordinary text and inner signs alone', () => {
    expect(toCsv(['h'], [['a=b'], ['x-y']])).toBe('h\r\na=b\r\nx-y');
  });
});

import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './parse.ts';
import { BOM, toCsv } from './write.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof CsvError ? e.code : String(e);
  }
  return 'none';
};

describe('parseCsv', () => {
  it('reads quoted newlines, quotes and numbers rows like a spreadsheet', () => {
    const r = parseCsv('a,b\r\n"line\nbreak","say ""hi"""\r\n\r\nx,y\r\n');
    expect(r.header).toEqual(['a', 'b']);
    expect(r.rows).toEqual([
      { row: 2, cells: ['line\nbreak', 'say "hi"'] },
      { row: 4, cells: ['x', 'y'] },
    ]);
  });

  it.each([
    [';', 'a;b\n1;2'],
    ['\t', 'a\tb\n1\t2'],
    [',', 'a,b\n1,2'],
  ])('detects the delimiter %j', (d, text) => {
    const r = parseCsv(text);
    expect(r.delimiter).toBe(d);
    expect(r.rows[0]?.cells).toEqual(['1', '2']);
  });

  it('keeps a delimiter inside quotes', () => {
    const r = parseCsv('a;b\n"1;2";3');
    expect(r.rows[0]?.cells).toEqual(['1;2', '3']);
  });

  it('strips a BOM from text and bytes, and accepts LF, CRLF and CR', () => {
    expect(parseCsv(`${BOM}a,b\n1,2`).header).toEqual(['a', 'b']);
    expect(parseCsv(bytes(`${BOM}a,b\r\n1,2`)).header).toEqual(['a', 'b']);
    expect(parseCsv('a,b\r1,2').rows).toHaveLength(1);
  });

  it('round-trips the formula guard', () => {
    const cells = ['=x', '-5', '@a', '+1', 'plain', "'quoted", '\tt'];
    const out = parseCsv(
      toCsv(
        cells.map((_, i) => `h${i}`),
        [cells],
      ),
    );
    expect(out.rows[0]?.cells).toEqual(cells);
    expect(toCsv(['h'], [['=x']])).toBe("h\r\n'=x");
  });

  it('guards a formula behind leading spaces, tabs or line breaks, and round-trips it', () => {
    const cells = [' =x', '\n=1+1', '  -5', '\t@a', ' plain', 'a=b'];
    const csv = toCsv(
      cells.map((_, i) => `h${i}`),
      [cells],
    );
    expect(toCsv(['h'], [[' =x']])).toBe("h\r\n' =x");
    expect(toCsv(['h'], [[' plain']])).toBe('h\r\n plain');
    expect(parseCsv(csv).rows[0]?.cells).toEqual(cells);
  });

  it('refuses spreadsheets, binary data and bad encodings', () => {
    expect(code(() => parseCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])))).toBe(
      'IMPORT_NOT_CSV',
    );
    expect(code(() => parseCsv('PK\u0003\u0004abc'))).toBe('IMPORT_NOT_CSV');
    expect(code(() => parseCsv(bytes('a,b\n1,\0')))).toBe('IMPORT_NOT_CSV');
    expect(code(() => parseCsv(new Uint8Array([0xff, 0xfe, 0x61, 0])))).toBe('IMPORT_ENCODING');
    expect(code(() => parseCsv(new Uint8Array([0x61, 0x2c, 0xff, 0x0a])))).toBe('IMPORT_ENCODING');
  });

  it('refuses file-level problems with a code', () => {
    expect(code(() => parseCsv('  \n'))).toBe('IMPORT_FILE_EMPTY');
    expect(code(() => parseCsv('a,,c\n1,2,3'))).toBe('IMPORT_HEADER_MISSING');
    expect(code(() => parseCsv('a,a\n1,2'))).toBe('IMPORT_HEADER_DUPLICATE');
    expect(
      code(() => parseCsv(`${Array.from({ length: 101 }, (_, i) => `c${i}`).join(',')}\n`)),
    ).toBe('IMPORT_TOO_MANY_COLUMNS');
    expect(code(() => parseCsv(`a\n${'1\n'.repeat(2001)}`))).toBe('IMPORT_TOO_MANY_ROWS');
    expect(parseCsv(`a\n${'1\n'.repeat(2000)}`).rows).toHaveLength(2000);
    expect(code(() => parseCsv(bytes(`a\n${'x'.repeat(2_000_001)}`)))).toBe(
      'IMPORT_FILE_TOO_LARGE',
    );
    expect(code(() => parseCsv(`a\n${'x'.repeat(2_000_001)}`))).toBe('IMPORT_FILE_TOO_LARGE');
  });

  it('counts UTF-8 bytes of a string, not characters', () => {
    expect(code(() => parseCsv(`a\n${'é'.repeat(1_000_001)}`))).toBe('IMPORT_FILE_TOO_LARGE');
    expect(code(() => parseCsv(`a\n${'é'.repeat(900_000)}`))).toBe('none');
  });

  it('refuses an unclosed quote and legacy .xls', () => {
    expect(code(() => parseCsv('a,b\n1,"two\n3,4'))).toBe('IMPORT_NOT_CSV');
    expect(code(() => parseCsv(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])))).toBe(
      'IMPORT_NOT_CSV',
    );
  });

  it('keeps ragged rows for the caller to report', () => {
    expect(parseCsv('a,b\n1').rows[0]?.cells).toEqual(['1']);
  });

  it('parses 2 MB in under 300 ms', () => {
    const line = '"Alex, ""A"" Chen",alex@example.com,A12345,2026-12-31,gold,"a\nb",42\n';
    const text = `name,email,id,date,tier,note,points\n${line.repeat(Math.floor(1_900_000 / line.length))}`;
    const rows = Math.floor(1_900_000 / line.length);
    const start = performance.now();
    const r = parseCsv(text, { maxRows: rows });
    const ms = performance.now() - start;
    expect(r.rows).toHaveLength(rows);
    expect(ms).toBeLessThan(300);
  });

  it('does not count blank or comma-only rows against the row cap', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    const full = rows(2000).join('\n');
    expect(parseCsv(`a\n${full}\n`).rows).toHaveLength(2000);
    expect(parseCsv(`a\r\n${rows(2000).join('\r\n')}\r\n\r\n`).rows).toHaveLength(2000);
    expect(parseCsv(`a,b\n${full.replace(/\n/g, ',x\n')},x\n,\n,\n,\n`).rows).toHaveLength(2000);
    const mixed = rows(1000).join('\n\n');
    expect(parseCsv(`a\n${mixed}\n`).rows).toHaveLength(1000);
    expect(code(() => parseCsv(`a\n${rows(2001).join('\n')}`))).toBe('IMPORT_TOO_MANY_ROWS');
    expect(code(() => parseCsv(`a\n${'\n'.repeat(30_000)}x`))).toBe('IMPORT_TOO_MANY_ROWS');
  });
});

import { describe, expect, it } from 'vitest';
import { toCsv } from '../csv/write.ts';
import { parseTabular, TabularError } from './index.ts';
import { buildXlsx, inline, n, rowsOf } from './xlsx-test-fixtures.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function code(bytes: Uint8Array, opts = {}): string {
  try {
    parseTabular(bytes, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(TabularError);
    return (e as TabularError).code;
  }
  return 'none';
}

describe('sniff and parse', () => {
  it('detects csv, json, ndjson and xlsx from content', () => {
    expect(parseTabular(enc('a;b\n1;2\n')).format).toBe('csv');
    expect(parseTabular(enc('a;b\n1;2\n')).records).toEqual([{ a: '1', b: '2' }]);
    expect(parseTabular(enc('[{"a":1}]')).format).toBe('json');
    expect(parseTabular(enc('{"a":1}\n{"a":2}\n')).format).toBe('ndjson');
    const x = buildXlsx({ sheets: [{ name: 'S', rows: rowsOf([inline('a')], [n(1)]) }] });
    expect(parseTabular(x).format).toBe('xlsx');
  });

  it('refuses unsupported and unreadable files with stable codes', () => {
    expect(code(new Uint8Array(0))).toBe('FILE_EMPTY');
    expect(code(enc('   \n'))).toBe('FILE_EMPTY');
    expect(code(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0, 0))).toBe('FILE_FORMAT_UNSUPPORTED');
    expect(code(Uint8Array.of(0xff, 0xfe, 0x61, 0))).toBe('FILE_ENCODING');
    expect(code(Uint8Array.of(0x61, 0x2c, 0xff, 0xfe, 0x0a, 0x31))).toBe('FILE_ENCODING');
    expect(code(Uint8Array.of(0x61, 0x2c, 0x00, 0x0a, 0x31, 0x2c))).toBe('FILE_FORMAT_UNSUPPORTED');
    expect(code(new Uint8Array(5 * 1024 * 1024 + 1))).toBe('FILE_TOO_LARGE');
    expect(code(Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2))).toBe('FILE_DAMAGED');
  });

  it('strips a BOM and handles quoted csv', () => {
    const t = parseTabular(enc('﻿name,note\n"A, B","x\ny"\n'));
    expect(t.records).toEqual([{ name: 'A, B', note: 'x\ny' }]);
  });

  it('keeps csv cells verbatim and removes only the export guard', () => {
    const out = toCsv(['f'], [['=SUM(A1)'], ['@x'], ['plain']]);
    expect(out).toContain("'=SUM(A1)");
    expect(parseTabular(enc(out)).records).toEqual([
      { f: '=SUM(A1)' },
      { f: '@x' },
      { f: 'plain' },
    ]);
    expect(parseTabular(enc('f\n=1+1\n')).records).toEqual([{ f: '=1+1' }]);
  });

  it('applies csv limits', () => {
    expect(code(enc('a,a\n1,2\n'))).toBe('FILE_HEADER_DUPLICATE');
    expect(code(enc('a,\n1,2\n'))).toBe('FILE_HEADER_MISSING');
    expect(code(enc('a,b\n'))).toBe('FILE_EMPTY');
    expect(code(enc(`${'x'.repeat(201)}\n1\n`))).toBe('FILE_HEADER_TOO_LONG');
    expect(code(enc(`a\n${'y'.repeat(2001)}\n`))).toBe('FILE_CELL_TOO_LONG');
    expect(code(enc('a\n"open\n'))).toBe('FILE_FORMAT_UNSUPPORTED');
    expect(code(enc('a,b\n1,2,3\n'))).toBe('FILE_ROW_SHAPE');
    expect(code(enc(`a\n${'1\n'.repeat(10_001)}`))).toBe('FILE_TOO_MANY_ROWS');
    expect(code(enc(`${Array.from({ length: 101 }, (_, i) => `c${i}`).join(',')}\n1\n`))).toBe(
      'FILE_TOO_MANY_COLUMNS',
    );
    expect(parseTabular(enc('a,b\n1\n')).records).toEqual([{ a: '1', b: '' }]);
  });

  it('keeps a __proto__ header as a plain key', () => {
    const r = parseTabular(enc('__proto__,b\nx,1\n')).records[0] as Record<string, unknown>;
    expect(Object.keys(r)).toEqual(['__proto__', 'b']);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('reads json by detection or pointer', () => {
    const doc = JSON.stringify({
      meta: { n: 1 },
      data: { items: [{ id: 1 }, { id: 2 }] },
      tags: [{ t: 1 }],
    });
    expect(parseTabular(enc(doc))).toMatchObject({
      recordsPointer: '/data/items',
      columns: ['id'],
    });
    expect(parseTabular(enc(doc), { recordsPointer: '/tags' }).records).toEqual([{ t: 1 }]);
    expect(code(enc(doc), { recordsPointer: '/nope' })).toBe('FILE_RECORDS_NOT_FOUND');
    expect(code(enc(doc), { recordsPointer: '/meta' })).toBe('FILE_NOT_RECORDS');
    expect(code(enc(doc), { recordsPointer: 'data' })).toBe('FILE_BAD_POINTER');
    expect(code(enc('{"a":1}'))).toBe('FILE_NOT_RECORDS');
    expect(code(enc('[1,2]'))).toBe('FILE_NOT_RECORDS');
    expect(code(enc('[{"a":1},2]'))).toBe('FILE_NOT_RECORDS');
    expect(code(enc('[]'))).toBe('FILE_EMPTY');
    expect(parseTabular(enc('[{"a":1}]'), { recordsPointer: '' }).recordsPointer).toBe('');
  });

  it('limits json depth, ndjson lines and truncation', () => {
    expect(code(enc(`${'['.repeat(33)}${']'.repeat(33)}`))).toBe('FILE_JSON_TOO_DEEP');
    expect(code(enc(`[{"a":${'['.repeat(40)}`))).toBe('FILE_JSON_TOO_DEEP');
    expect(code(enc(`{"a":"${'x'.repeat(70_000)}"}\n{"a":1}\n`))).toBe('FILE_LINE_TOO_LONG');
    expect(code(enc('{"a":1}\n[1]\n'))).toBe('FILE_NOT_RECORDS');
    expect(code(enc('[{"a":1},{"a"'))).toBe('FILE_DAMAGED');
    expect(code(enc('{"a":1}\n{"a"'))).toBe('FILE_DAMAGED');
    expect(code(enc('[{"a":"é"}]'.slice(0, 7)))).toBe('FILE_DAMAGED');
  });

  it('throws only TabularError for every truncation of each text format', () => {
    const samples = [
      'a,b\n"x, y",2\n3,4\n',
      '[{"a":1,"b":"é"},{"a":2}]',
      '{"a":1}\n{"a":2}\n',
      '﻿a;b\n1;2\n',
    ];
    for (const text of samples) {
      const bytes = enc(text);
      for (let len = 0; len <= bytes.length; len++) {
        try {
          parseTabular(bytes.slice(0, len));
        } catch (e) {
          expect(e).toBeInstanceOf(TabularError);
        }
      }
    }
  });
});

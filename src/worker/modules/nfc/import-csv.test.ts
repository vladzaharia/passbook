import { describe, expect, it } from 'vitest';
import { parseImportCsv } from './import-csv.ts';

const K1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const K2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

describe('parseImportCsv', () => {
  it('reads a header in any order, and a file without one', () => {
    const named = parseImportCsv(`Key,UID\n${K1},04:aa:00:00:00:00:01\n`);
    expect(named.rows).toEqual([{ line: 2, uid: '04aa0000000001', key: K1 }]);
    const bare = parseImportCsv(`04AA0000000002,${K2.toUpperCase()}\r\n\r\n04aa0000000003,${K1}`);
    expect(bare.rows.map((r) => [r.line, r.uid, r.key])).toEqual([
      [1, '04aa0000000002', K2],
      [3, '04aa0000000003', K1],
    ]);
  });

  it('takes semicolons, tabs, quotes and a byte order mark', () => {
    for (const text of [
      `﻿uid;key\n04aa0000000001;${K1}`,
      `uid\tkey\n04aa0000000001\t${K1}`,
      `"uid","key"\n"04aa0000000001","${K1}"`,
    ])
      expect(parseImportCsv(text).rows).toEqual([
        { line: expect.any(Number), uid: '04aa0000000001', key: K1 },
      ]);
  });

  it('lists bad rows without echoing a cell that was not a tag ID, and never a key', () => {
    const out = parseImportCsv(
      [
        'uid,key',
        `${K1},04aa0000000001`,
        '04aa0000000002,xyz',
        `04aa0000000003,${'0'.repeat(32)}`,
        `04aa0000000004,${K1}`,
        `04aa0000000004,${K2}`,
        `0401,${K2}`,
      ].join('\n'),
    );
    expect(out.rows).toEqual([{ line: 5, uid: '04aa0000000004', key: K1 }]);
    expect(out.problems).toEqual([
      { line: 2, uid: null, reason: 'bad_uid' },
      { line: 3, uid: '04aa0000000002', reason: 'bad_key' },
      { line: 4, uid: '04aa0000000003', reason: 'weak_key' },
      { line: 6, uid: '04aa0000000004', reason: 'dup_file' },
      { line: 7, uid: null, reason: 'bad_uid' },
    ]);
    expect(JSON.stringify(out.problems)).not.toContain(K2);
    expect(JSON.stringify(out.problems)).not.toContain(K1);
  });

  it('imports none of the rows that share a key: that is not a key per tag', () => {
    const out = parseImportCsv(`04aa0000000001,${K1}\n04aa0000000002,${K2}\n04aa0000000003,${K1}`);
    expect(out.rows.map((r) => r.uid)).toEqual(['04aa0000000002']);
    expect(out.problems.map((p) => [p.line, p.reason])).toEqual([
      [1, 'dup_key'],
      [3, 'dup_key'],
    ]);
  });

  it('refuses an empty file, a header with no uid or key column, and too many rows', () => {
    const code = (text: string) => {
      try {
        parseImportCsv(text);
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    expect(code('\n\n')).toBe('IMPORT_EMPTY');
    expect(code('serial,secret\n1,2')).toBe('IMPORT_HEADER');
    const many = Array.from(
      { length: 501 },
      (_, i) => `04aa${i.toString(16).padStart(10, '0')},${K1}`,
    );
    expect(code(many.join('\n'))).toBe('IMPORT_TOO_MANY');
    expect(parseImportCsv(many.slice(0, 500).join('\n')).count).toBe(500);
  });
});

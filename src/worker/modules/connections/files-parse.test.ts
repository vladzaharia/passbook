import { describe, expect, it } from 'vitest';
import { entriesOf } from './files-parse.ts';

describe('entriesOf refs', () => {
  const refs = (ids: unknown[]) =>
    entriesOf(
      ids.map((id) => ({ id })),
      '/id',
    );

  it('gives a CSV cell and the same XLSX number one ref', () => {
    const csv = refs(['12345', ' 12345.0 ', '-7.00', '3.5']);
    expect(csv.entries.map((e) => e.ref)).toEqual(['12345', '-7', '3.5']);
    expect(csv.duplicate).toBe(1);
    expect(refs([12345, -7, 3.5]).entries.map((e) => e.ref)).toEqual(['12345', '-7', '3.5']);
  });

  it('keeps leading zeros and text ids as written, trimmed', () => {
    expect(refs(['001', ' A-1 ', '1.05']).entries.map((e) => e.ref)).toEqual([
      '001',
      'A-1',
      '1.05',
    ]);
  });

  it('skips blank and non-finite ids', () => {
    const r = refs(['', '  ', Number.NaN, null]);
    expect([r.entries.length, r.noId]).toEqual([0, 4]);
  });
});

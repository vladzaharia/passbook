import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inflateGuarded, ZipError } from '../zip/inflate-guarded.ts';
import { parseTabular, TabularError } from './index.ts';
import { parseXlsx } from './xlsx.ts';
import { classifyFormat, serialToValue } from './xlsx-cells.ts';
import { buildXlsx, inline, n, rowsOf } from './xlsx-test-fixtures.ts';
import { parseXml } from './xlsx-xml.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const MB = 1024 * 1024;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TabularError);
    return (e as TabularError).code;
  }
  return 'none';
}

/** Bytes held by this process, or null where the runtime has no process.memoryUsage. */
function held(): number | null {
  try {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  } catch {
    return null;
  }
}

function peakRss(): number | null {
  try {
    return process.resourceUsage().maxRSS;
  } catch {
    return null;
  }
}

/** Seeded text with ~1 bit of entropy per character: compresses about 8:1, never past the ratio cap. */
function noise(length: number): string {
  let x = 12345;
  let out = '';
  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += x & 0x10000 ? 'a' : 'b';
    if (out.length >= 65_536) {
      parts.push(out);
      out = '';
    }
  }
  parts.push(out);
  return parts.join('');
}

describe('memory', () => {
  it('a 5 MB csv of long unquoted cells stays near its own size', () => {
    const cell = 'x'.repeat(1990);
    const text = `h\n${`${cell}\n`.repeat(Math.floor((5 * MB) / 1991) - 1)}`;
    const bytes = enc(text);
    expect(bytes.length).toBeLessThanOrEqual(5 * MB);
    const before = held();
    const t = parseTabular(bytes);
    const after = held();
    expect(t.records.length).toBeGreaterThan(2000);
    if (before !== null && after !== null) expect(after - before).toBeLessThan(40 * MB);
  });

  it('a near-cap xlsx sheet does not multiply its size', () => {
    const body = `<worksheet><sheetData>${rowsOf([inline('a')], [n(1)])}</sheetData><!--${noise(22 * MB)}--></worksheet>`;
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: '' }],
      files: { 'xl/worksheets/sheet1.xml': body },
    });
    expect(bytes.length).toBeLessThan(5 * MB);
    const before = peakRss();
    const t = parseXlsx(bytes);
    const after = peakRss();
    expect(t.records).toEqual([{ a: 1 }]);
    // maxRSS is KB; the sheet is 22 MB inflated, decoded once and tokenised.
    if (before !== null && after !== null) expect((after - before) / 1024).toBeLessThan(160);
  });
});

describe('quadratic inputs', () => {
  it('an attribute body with no = is linear', () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const xml = enc(`<a ${'x'.repeat(8000)}/>`);
      expect(code(() => parseXml(xml, { open() {}, text() {}, close() {} }))).toBe('FILE_DAMAGED');
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('a long unterminated number format is refused fast', () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      expect(code(() => classifyFormat(`${';'.repeat(8000)}"`))).toBe('FILE_DAMAGED');
      expect(classifyFormat(`${';'.repeat(200)}"`)).toBeNull();
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('honours quotes and escapes when splitting number format sections', () => {
    expect(classifyFormat('"a;b"0.00;yyyy')).toBeNull();
    expect(classifyFormat('0;0;yyyy')).toBeNull();
    expect(classifyFormat('yyyy;0.00')).toBe('date');
  });
});

describe('row caps stop early', () => {
  it('xlsx past the row cap throws while reading', () => {
    const rows = Array.from(
      { length: 200_000 },
      (_, i) => `<row><c><v>${i * 7919}</v></c></row>`,
    ).join('');
    const bytes = buildXlsx({
      sheets: [
        { name: 'S', rows: `<row r="1">${inline('a').replace('<c ', '<c r="A1" ')}</row>${rows}` },
      ],
    });
    const start = performance.now();
    expect(code(() => parseXlsx(bytes))).toBe('FILE_TOO_MANY_ROWS');
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('csv past the row cap throws while tokenising', () => {
    const bytes = enc(`h\n${'a\n'.repeat(2_600_000)}`);
    const start = performance.now();
    expect(code(() => parseTabular(bytes))).toBe('FILE_TOO_MANY_ROWS');
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('a csv row wider than the hard cap throws', () => {
    const bytes = enc(`${','.repeat(5000)}\n1\n`);
    expect(code(() => parseTabular(bytes))).toBe('FILE_TOO_MANY_COLUMNS');
  });
});

describe('zip sizes', () => {
  it('refuses a central directory that claims more compressed bytes than the archive holds', () => {
    const zip = zipSync({ a: strToU8('hello'.repeat(100)), b: strToU8('x') });
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let patched = 0;
    for (let i = 0; i + 46 < zip.length; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) {
        dv.setUint32(i + 20, 0x7fffffff, true);
        patched++;
      }
    }
    expect(patched).toBe(2);
    const limits = {
      archiveBytes: MB,
      rawEntries: 10,
      entryBytes: MB,
      totalBytes: MB,
      ratio: 100,
      ratioFloor: 64 * 1024,
    };
    try {
      inflateGuarded(zip, limits, () => true);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ZipError);
      expect((e as ZipError).code).toBe('ZIP_INVALID');
    }
  });
});

describe('wide objects and records', () => {
  it('too many columns throws inside the first record', () => {
    const wide = JSON.stringify([
      Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, 1])),
    ]);
    expect(code(() => parseTabular(enc(wide)))).toBe('FILE_TOO_MANY_COLUMNS');
  });
});

describe('small fixes', () => {
  it('a time of day that rounds to midnight wraps within the day', () => {
    expect(serialToValue(0.9999999, 'time', false)).toBe('00:00:00');
    expect(serialToValue(44197.9999999, 'datetime', false)).toBe('2021-01-02T00:00:00');
  });

  it('reads a hidden sheet only when it is named', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'H', rows: rowsOf([inline('h')], [n(1)]), hidden: true }],
    });
    expect(code(() => parseXlsx(bytes))).toBe('FILE_EMPTY');
    expect(parseXlsx(bytes, { sheet: 'H' }).records).toEqual([{ h: 1 }]);
  });

  it('a sheet name like __proto__ does not break attributes', () => {
    const bytes = buildXlsx({
      sheets: [{ name: '__proto__', rows: rowsOf([inline('a')], [n(1)]) }],
    });
    expect(parseXlsx(bytes, { sheet: '__proto__' }).records).toEqual([{ a: 1 }]);
  });
});

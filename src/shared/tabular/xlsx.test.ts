import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TabularError } from './limits.ts';
import { parseXlsx } from './xlsx.ts';
import { serialToValue } from './xlsx-cells.ts';
import { buildXlsx, inline, n, rowsOf, s } from './xlsx-test-fixtures.ts';

const header = [inline('id'), inline('name')];

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TabularError);
    return (e as TabularError).code;
  }
  return 'none';
}

describe('xlsx', () => {
  it('reads shared and inline strings, numbers and booleans', () => {
    const bytes = buildXlsx({
      shared: ['id', 'name', 'Ann'],
      sheets: [
        {
          name: 'People',
          rows: rowsOf(
            [s(0), s(1), inline('ok')],
            [n(1), s(2), '<c t="b"><v>1</v></c>'],
            [n('2.5'), inline('Bo & <Cy>'), '<c t="b"><v>0</v></c>'],
          ),
        },
      ],
    });
    const t = parseXlsx(bytes);
    expect(t.sheet).toBe('People');
    expect(t.columns).toEqual(['id', 'name', 'ok']);
    expect(t.records).toEqual([
      { id: 1, name: 'Ann', ok: true },
      { id: 2.5, name: 'Bo & <Cy>', ok: false },
    ]);
  });

  it('gives cached formula values, empty errors and ignores merged cells', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: rowsOf(
            header,
            [n(1), '<c t="str"><f>A2&amp;"x"</f><v>cached</v></c>'],
            [n(2), '<c t="e"><v>#DIV/0!</v></c>'],
            [n(3), '<c><f>1+1</f></c>'],
          ),
          extra: '<mergeCells count="1"><mergeCell ref="B2:B3"/></mergeCells>',
        },
      ],
    });
    expect(parseXlsx(bytes).records).toEqual([
      { id: 1, name: 'cached' },
      { id: 2, name: null },
      { id: 3, name: null },
    ]);
  });

  it('refuses a merged header that leaves a column unnamed', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: rowsOf([inline('a'), '<c/>', inline('c')], [n(1), n(2), n(3)]) }],
    });
    expect(code(() => parseXlsx(bytes))).toBe('FILE_HEADER_MISSING');
  });

  it('formats dates in the 1900 and 1904 systems', () => {
    const rows = rowsOf(
      [inline('d'), inline('t'), inline('x')],
      [n(44197, 1), n(44197.75, 2), n(44197, 3)],
    );
    const f = {
      sheets: [{ name: 'S', rows }],
      numFmts: [[164, 'yyyy-mm-dd hh:mm'] as [number, string]],
      xfs: [14, 164, 2],
    };
    expect(parseXlsx(buildXlsx(f)).records[0]).toEqual({
      d: '2021-01-01',
      t: '2021-01-01T18:00:00',
      x: 44197,
    });
    expect(parseXlsx(buildXlsx({ ...f, date1904: true })).records[0]).toEqual({
      d: '2025-01-02',
      t: '2025-01-02T18:00:00',
      x: 44197,
    });
  });

  it('handles date edge cases', () => {
    expect(serialToValue(1, 'date', false)).toBe('1900-01-01');
    expect(serialToValue(59, 'date', false)).toBe('1900-02-28');
    expect(serialToValue(60, 'date', false)).toBe(60);
    expect(serialToValue(61, 'date', false)).toBe('1900-03-01');
    expect(serialToValue(0, 'date', false)).toBe(0);
    expect(serialToValue(-1, 'date', false)).toBe(-1);
    expect(serialToValue(0, 'date', true)).toBe('1904-01-01');
    expect(serialToValue(25569, 'date', false)).toBe('1970-01-01');
    expect(serialToValue(2958465, 'date', false)).toBe('9999-12-31');
    expect(serialToValue(2958466, 'date', false)).toBe(2958466);
    expect(serialToValue(Number.NaN, 'date', false)).toBeNaN();
    // rounds to the second and carries into the next day
    expect(serialToValue(44197.999999999, 'datetime', false)).toBe('2021-01-02T00:00:00');
    expect(serialToValue(44197.5, 'datetime', false)).toBe('2021-01-01T12:00:00');
    expect(serialToValue(0.25, 'time', false)).toBe('06:00:00');
    expect(serialToValue(1.5, 'elapsed', false)).toBe(1.5);
    expect(serialToValue(44197.5, 'date', false)).toBe('2021-01-01');
  });

  it('classifies custom formats', () => {
    const f = (code: string, v = 44197) =>
      parseXlsx(
        buildXlsx({
          sheets: [{ name: 'S', rows: rowsOf([inline('a')], [n(v, 1)]) }],
          numFmts: [[170, code]],
          xfs: [170],
        }),
      ).records[0]?.a;
    expect(f('0.00')).toBe(44197);
    expect(f('General')).toBe(44197);
    expect(f('#,##0 "days"')).toBe(44197);
    expect(f('0.0E+00')).toBe(44197);
    expect(f('dd/mm/yyyy')).toBe('2021-01-01');
    expect(f('[$-409]d-mmm-yy;@')).toBe('2021-01-01');
    expect(f('[h]:mm:ss')).toBe(44197);
    expect(f('mmmm')).toBe('2021-01-01');
  });

  it('reads several sheets and picks by name or first non-empty visible', () => {
    const bytes = buildXlsx({
      sheets: [
        { name: 'Empty', rows: '' },
        { name: 'Hidden', rows: rowsOf([inline('h')], [n(9)]), hidden: true },
        { name: 'A', rows: rowsOf([inline('a')], [n(1)]) },
        { name: 'B', rows: rowsOf([inline('b')], [n(2)]) },
      ],
    });
    expect(parseXlsx(bytes).sheet).toBe('A');
    expect(parseXlsx(bytes).sheets).toEqual(['Empty', 'Hidden', 'A', 'B']);
    expect(parseXlsx(bytes, { sheet: 'B' }).records).toEqual([{ b: 2 }]);
    expect(parseXlsx(bytes, { sheet: 'Hidden' }).records).toEqual([{ h: 9 }]);
    expect(code(() => parseXlsx(bytes, { sheet: 'Nope' }))).toBe('FILE_SHEET_NOT_FOUND');
  });

  it('refuses macro, binary and non-sheet packages', () => {
    const sheets = [{ name: 'S', rows: rowsOf(header, [n(1), n(2)]) }];
    expect(
      code(() =>
        parseXlsx(
          buildXlsx({
            sheets,
            contentType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
          }),
        ),
      ),
    ).toBe('FILE_MACRO');
    expect(code(() => parseXlsx(buildXlsx({ sheets, files: { 'xl/vbaProject.bin': 'x' } })))).toBe(
      'FILE_MACRO',
    );
    expect(
      code(() =>
        parseXlsx(
          buildXlsx({
            sheets,
            contentType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.main',
          }),
        ),
      ),
    ).toBe('FILE_FORMAT_UNSUPPORTED');
    expect(
      code(() =>
        parseXlsx(
          buildXlsx({
            sheets,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
          }),
        ),
      ),
    ).toBe('FILE_FORMAT_UNSUPPORTED');
    expect(
      code(() =>
        parseXlsx(zipSync({ mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet') })),
      ),
    ).toBe('FILE_FORMAT_UNSUPPORTED');
  });

  it('refuses DOCTYPE and entities without expanding them', () => {
    const sheets = [{ name: 'S', rows: rowsOf(header, [n(1), n(2)]) }];
    const lol = '<!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>';
    expect(code(() => parseXlsx(buildXlsx({ sheets, prolog: lol })))).toBe('FILE_XML_UNSAFE');
    const ref = buildXlsx({
      sheets: [
        { name: 'S', rows: rowsOf(header, [inline('&custom;'), n(2)]).replace('&amp;', '&') },
      ],
    });
    expect(code(() => parseXlsx(ref))).toBe('FILE_XML_UNSAFE');
    expect(
      code(() =>
        parseXlsx(buildXlsx({ sheets, files: { 'xl/worksheets/extra.xml': '<!DOCTYPE x>' } })),
      ),
    ).toBe('none');
  });

  it('decodes numeric references and refuses bad ones', () => {
    const ok = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: rowsOf([inline('a')], ['<c t="inlineStr"><is><t>&#65;&#x42;&lt;</t></is></c>']),
        },
      ],
    });
    expect(parseXlsx(ok).records).toEqual([{ a: 'AB<' }]);
    const bad = buildXlsx({
      sheets: [
        { name: 'S', rows: rowsOf([inline('a')], ['<c t="inlineStr"><is><t>&#0;</t></is></c>']) },
      ],
    });
    expect(code(() => parseXlsx(bad))).toBe('FILE_XML_UNSAFE');
  });

  it('skips phonetic runs and reads rich text', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: rowsOf(
            [inline('a')],
            [
              '<c t="inlineStr"><is><r><t>He</t></r><r><t>llo</t></r><rPh><t>PHONE</t></rPh></is></c>',
            ],
          ),
        },
      ],
    });
    expect(parseXlsx(bytes).records).toEqual([{ a: 'Hello' }]);
  });

  it('enforces header, shape and size rules', () => {
    const mk = (rows: string) => buildXlsx({ sheets: [{ name: 'S', rows }] });
    expect(code(() => parseXlsx(mk(rowsOf([inline('a'), inline('a')], [n(1), n(2)]))))).toBe(
      'FILE_HEADER_DUPLICATE',
    );
    expect(code(() => parseXlsx(mk(rowsOf([inline('a')]))))).toBe('FILE_EMPTY');
    expect(code(() => parseXlsx(mk('')))).toBe('FILE_EMPTY');
    expect(code(() => parseXlsx(mk(rowsOf([inline('a')], [n(1), n(2)]))))).toBe('FILE_ROW_SHAPE');
    expect(code(() => parseXlsx(mk(rowsOf([inline('x'.repeat(201))], [n(1)]))))).toBe(
      'FILE_HEADER_TOO_LONG',
    );
    expect(code(() => parseXlsx(mk(rowsOf([inline('a')], [inline('y'.repeat(2001))]))))).toBe(
      'FILE_CELL_TOO_LONG',
    );
    const wide = Array.from({ length: 101 }, (_, i) => inline(`c${i}`));
    expect(
      code(() =>
        parseXlsx(
          mk(
            rowsOf(
              wide,
              wide.map(() => n(1)),
            ),
          ),
        ),
      ),
    ).toBe('FILE_TOO_MANY_COLUMNS');
    const tall = Array.from({ length: 10_002 }, () => [n(1)]);
    expect(code(() => parseXlsx(mk(rowsOf([inline('a')], ...tall))))).toBe('FILE_TOO_MANY_ROWS');
  });

  it('refuses a shared-string index out of range', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: rowsOf([inline('a')], [s(5)]) }],
      shared: ['x'],
    });
    expect(code(() => parseXlsx(bytes))).toBe('FILE_DAMAGED');
  });

  it('refuses a zip bomb and understated sizes', () => {
    const big = `<?xml version="1.0"?><worksheet><sheetData>${'<row><c><v>1</v></c></row>'.repeat(1)}</sheetData><!--${'a'.repeat(41 * 1024 * 1024)}--></worksheet>`;
    const bomb = buildXlsx({
      sheets: [{ name: 'S', rows: rowsOf([inline('a')], [n(1)]) }],
      files: { 'xl/worksheets/sheet1.xml': big },
    });
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect(code(() => parseXlsx(bomb))).toBe('FILE_ARCHIVE_LIMIT');

    // Central directory claims 10 bytes while the entry really inflates to far more.
    const real = buildXlsx({
      sheets: [{ name: 'S', rows: rowsOf([inline('a')], [n(1)]) }],
      files: {
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData/><!--${'b'.repeat(200_000)}--></worksheet>`,
      },
    });
    const lied = understate(real, 'xl/worksheets/sheet1.xml', 10);
    expect(code(() => parseXlsx(lied))).toBe('FILE_DAMAGED');
  });

  it('refuses a high declared ratio', () => {
    const body = `<worksheet><sheetData/><!--${'c'.repeat(3 * 1024 * 1024)}--></worksheet>`;
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: rowsOf([inline('a')], [n(1)]) }],
      files: { 'xl/worksheets/sheet1.xml': body },
    });
    expect(code(() => parseXlsx(bytes))).toBe('FILE_ARCHIVE_LIMIT');
  });

  it('throws only TabularError for every truncation and byte flip', () => {
    const bytes = buildXlsx({
      shared: ['id', 'name', 'Ann'],
      numFmts: [[164, 'yyyy-mm-dd']],
      xfs: [164],
      sheets: [{ name: 'P', rows: rowsOf([s(0), s(1)], [n(44197, 1), s(2)]) }],
    });
    expect(parseXlsx(bytes).records).toHaveLength(1);
    for (let len = 0; len < bytes.length; len++) {
      try {
        parseXlsx(bytes.slice(0, len));
      } catch (e) {
        expect(e).toBeInstanceOf(TabularError);
      }
    }
    for (let at = 0; at < bytes.length; at += 7) {
      const copy = bytes.slice();
      copy[at] = (copy[at] ?? 0) ^ 0xff;
      try {
        parseXlsx(copy);
      } catch (e) {
        expect(e).toBeInstanceOf(TabularError);
      }
    }
  });
});

/** Rewrites an entry's uncompressed size in both the local and central headers. */
function understate(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  const nameBytes = strToU8(name);
  for (let i = 0; i + 4 < out.length; i++) {
    const sig = dv.getUint32(i, true);
    const nameAt = sig === 0x02014b50 ? i + 46 : sig === 0x04034b50 ? i + 30 : -1;
    const nameLen = nameAt < 0 ? 0 : dv.getUint16(i + (sig === 0x02014b50 ? 28 : 26), true);
    if (nameAt < 0 || nameLen !== nameBytes.length) continue;
    if (!nameBytes.every((b, k) => out[nameAt + k] === b)) continue;
    dv.setUint32(i + (sig === 0x02014b50 ? 24 : 22), size, true);
  }
  return out;
}

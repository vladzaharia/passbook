import { describe, expect, it } from 'vitest';
import { compareRows, expectedRows, matchText, variants } from './compare.ts';

const pass = {
  organizationName: 'Northwind',
  backgroundColor: 'rgb(181,64,0)',
  expirationDate: '2030-01-01T00:00:00Z',
  barcodes: [{ format: 'PKBarcodeFormatPDF417', message: 'SCAN-0001' }],
  coupon: {
    primaryFields: [{ key: 'offer', label: 'Offer', value: '20% off' }],
    backFields: [{ key: 'terms', label: 'Valid for', value: 'One purchase' }],
  },
};

describe('expectedRows', () => {
  it('lists fields by group, then meta, barcode and colors', () => {
    expect(expectedRows(pass).map((r) => r.path)).toEqual([
      'primaryFields.offer',
      'backFields.terms',
      'organizationName',
      'expirationDate',
      'barcodes.0',
      'backgroundColor',
    ]);
  });
});

describe('variants', () => {
  it('writes an ISO date the way surfaces show it', () => {
    expect(variants('2030-01-01T00:00:00Z')).toContain('Jan 1, 2030');
  });
  it('writes rgb as hex', () => {
    expect(variants('rgb(181,64,0)')).toContain('#b54000');
  });
});

describe('matchText', () => {
  const row = {
    path: 'backFields.terms',
    kind: 'field',
    label: 'Valid for',
    value: 'One purchase',
  } as const;
  it('shown when the value is there, ignoring case and spacing', () => {
    expect(matchText(row, 'VALID FOR\n one   purchase')).toBe('shown');
  });
  it('partial when only the label is there', () => {
    expect(matchText(row, 'Valid for: 2 purchases')).toBe('partial');
  });
  it('missing when neither is there', () => {
    expect(matchText(row, 'nothing')).toBe('missing');
  });
});

describe('compareRows', () => {
  const rows = expectedRows(pass);
  const out = compareRows(rows, {
    apple: { kind: 'source' },
    hosted: {
      kind: 'text',
      text: 'Offer 20% off. Valid for One purchase. Expires Jan 1, 2030. Northwind',
    },
    google: {
      kind: 'wallet',
      text: '{"offer":"20% off","terms":"One purchase"}',
      items: [{ path: 'backFields.terms', support: 'omitted' }],
    },
    gone: { kind: 'none' },
  });
  const by = (path: string) => out.find((r) => r.path === path);

  it('marks what each surface shows', () => {
    expect(by('primaryFields.offer')?.cells).toEqual({
      apple: 'shown',
      hosted: 'shown',
      google: 'shown',
      gone: 'unknown',
    });
  });
  it('an omission reported by a compiler wins over a text hit', () => {
    expect(by('backFields.terms')?.cells.google).toBe('omitted');
    expect(by('backFields.terms')?.differs).toBe(true);
  });
  it('a surface that cannot read a kind does not count as a difference', () => {
    const [color] = compareRows(
      rows.filter((r) => r.kind === 'color'),
      { web: { kind: 'text', text: '', reads: ['field'] } },
    );
    expect(color?.cells.web).toBe('na');
    expect(color?.differs).toBe(false);
  });
  it('an empty field is not a difference on a text or wallet surface', () => {
    const [empty] = compareRows(
      [{ path: 'backFields.note', kind: 'field', label: 'Note', value: '' }],
      {
        web: { kind: 'text', text: 'anything' },
        google: { kind: 'wallet', text: '{}', items: [] },
      },
    );
    expect(empty?.cells).toEqual({ web: 'na', google: 'na' });
    expect(empty?.differs).toBe(false);
  });
  it('a gap on an informational surface does not make a row differ', () => {
    const [offer] = compareRows(
      rows.filter((r) => r.path === 'primaryFields.offer'),
      { mail: { kind: 'text', text: 'hello', informational: true } },
    );
    expect(offer?.cells.mail).toBe('missing');
    expect(offer?.differs).toBe(false);
  });
  it('unknown surfaces are not differences', () => {
    expect(by('primaryFields.offer')?.differs).toBe(false);
  });
});

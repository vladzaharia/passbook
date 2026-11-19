import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { validateManifest } from './manifest.ts';
import { DERIVED_PAPER, PAPER_SPECS, paperManifestIssues, resolvePaper } from './paper.ts';
import { paperContent } from './paper-content.ts';
import { EVENT_MANIFEST, EVENT_PASS } from './paper-fixtures.ts';

const withPaper = (paper: unknown): TemplateManifest =>
  ({ ...EVENT_MANIFEST, paper }) as unknown as TemplateManifest;
const codes = (paper: unknown) =>
  paperManifestIssues(withPaper(paper), { passJson: EVENT_PASS }).map((i) => i.code);

describe('paper block validation', () => {
  it('has no issues when absent or when valid', () => {
    expect(paperManifestIssues(EVENT_MANIFEST)).toEqual([]);
    expect(
      codes({ schema: 1, size: 'half', barcode: 'code128', fields: ['level'], holder: false }),
    ).toEqual([]);
    expect(codes({ schema: 1, size: 'a4', barcode: 'qr', terms: 'See {{terms}}' })).toEqual([]);
  });

  it('refuses a bad version, size, barcode, field list and unknown key', () => {
    expect(codes({ schema: 2, size: 'a4', barcode: 'qr' })).toEqual(['PAPER_VERSION']);
    expect(codes({ schema: 1, size: 'a3', barcode: 'qr' })).toEqual(['PAPER_SIZE']);
    expect(codes({ schema: 1, size: 'a4', barcode: 'pdf417' })).toEqual(['PAPER_BARCODE']);
    expect(codes({ schema: 1, size: 'a4', barcode: 'qr', fields: ['a', 'a'] })).toEqual([
      'PAPER_FIELD',
    ]);
    expect(codes({ schema: 1, size: 'a4', barcode: 'qr', extra: 1 })).toEqual([
      'PAPER_UNKNOWN_KEY',
    ]);
    expect(codes('a4')).toEqual(['PAPER_SHAPE']);
  });

  it('never prints the scan code or the scan lookup value', () => {
    const base = { schema: 1, size: 'a4', barcode: 'qr' };
    expect(codes({ ...base, terms: 'Code {{pass.scanCode}}' })).toContain('PAPER_SCAN_CODE');
    expect(codes({ ...base, terms: 'No. {{ticketNo}}' })).toContain('PAPER_LOOKUP_FIELD');
    // `order` is bound to the lookup input: naming it prints the lookup value.
    expect(codes({ ...base, fields: ['order'] })).toContain('PAPER_LOOKUP_FIELD');
  });

  it('refuses a field bound to the scan code and a card with Code 128', () => {
    const m = {
      ...EVENT_MANIFEST,
      bindings: [{ to: { field: 'level' }, value: '{{pass.scanCode}}' }],
      paper: { schema: 1, size: 'a4', barcode: 'qr', fields: ['level'] },
    } as unknown as TemplateManifest;
    expect(paperManifestIssues(m, { passJson: EVENT_PASS }).map((i) => i.code)).toEqual([
      'PAPER_SCAN_CODE',
    ]);
    expect(codes({ schema: 1, size: 'cr80', barcode: 'code128' })).toEqual(['PAPER_BARCODE']);
    expect(resolvePaper({ schema: 1, size: 'cr80', barcode: 'code128' }).barcode).toBe('qr');
  });

  it('warns on a field that is not on the pass', () => {
    const issues = paperManifestIssues(
      withPaper({ schema: 1, size: 'a4', barcode: 'qr', fields: ['nope'] }),
      {
        passJson: EVENT_PASS,
      },
    );
    expect(issues).toMatchObject([{ severity: 'warning', code: 'PAPER_FIELD' }]);
  });

  it('runs inside validateManifest', () => {
    const issues = validateManifest(withPaper({ schema: 1, size: 'a3', barcode: 'qr' }));
    expect(issues.some((i) => i.code === 'PAPER_SIZE')).toBe(true);
  });
});

describe('paper design', () => {
  it('derives when absent or invalid, fills defaults when present', () => {
    expect(resolvePaper(undefined)).toBe(DERIVED_PAPER);
    expect(resolvePaper({ nope: true })).toBe(DERIVED_PAPER);
    expect(resolvePaper({ schema: 1, size: 'half', barcode: 'code128', holder: false })).toEqual({
      size: 'half',
      barcode: 'code128',
      fields: [],
      holder: false,
      derived: false,
    });
    expect(resolvePaper({ schema: 1, size: 'a4', barcode: 'qr' }).holder).toBe(true);
  });

  it('keeps every QR at 3 cm or more', () => {
    for (const spec of Object.values(PAPER_SPECS)) expect(spec.qrMm).toBeGreaterThanOrEqual(30);
  });
});

describe('paper content derivation', () => {
  const content = (design = DERIVED_PAPER, holderName?: string) =>
    paperContent({
      passJson: EVENT_PASS,
      manifest: EVENT_MANIFEST,
      personalization: { name: 'Ada', ticketNo: 'T-77' },
      design,
      ...(holderName ? { holderName } : {}),
    });

  it('reads event, date, venue, holder, type and seat from the roles', () => {
    expect(content()).toEqual({
      brand: 'Northwind Hall',
      event: 'Spring Concert',
      date: 'Mon, April 12, 2027 at 7:30 PM',
      venue: 'Northwind Hall',
      holder: 'Ada Lovelace',
      type: 'General admission',
      seat: 'Section B, Row 4, Seat 12',
      extras: [],
    });
  });

  it('never carries the scan code or the lookup value', () => {
    const json = JSON.stringify(
      content({ ...DERIVED_PAPER, fields: ['order', 'level'], derived: false }),
    );
    expect(json).not.toContain('SECRET-SCAN-CODE');
    expect(json).not.toContain('T-77');
    expect(json).toContain('Balcony');
  });

  it('drops a field whose text is the barcode message, its alt text or the serial', () => {
    const pass = {
      ...EVENT_PASS,
      serialNumber: 'SER-9',
      eventTicket: {
        ...(EVENT_PASS as unknown as { eventTicket: object }).eventTicket,
        auxiliaryFields: [
          { key: 'a', label: 'A', value: 'SECRET-SCAN-CODE' },
          { key: 'b', label: 'B', value: 'SER-9' },
          { key: 'c', label: 'C', value: 'ok' },
        ],
      },
    } as never;
    const out = paperContent({
      passJson: pass,
      manifest: EVENT_MANIFEST,
      personalization: {},
      design: { ...DERIVED_PAPER, derived: false, fields: ['a', 'b', 'c'] },
    });
    expect(out.extras).toEqual([{ label: 'C', text: 'ok' }]);
    // The barcode message is not the scan code, but a field equals it.
    const other = paperContent({
      passJson: pass,
      manifest: EVENT_MANIFEST,
      personalization: {},
      scanCode: 'ok',
      design: { ...DERIVED_PAPER, derived: false, fields: ['a', 'b', 'c'] },
    });
    expect(other.extras).toEqual([]);
  });

  it('takes terms from the design and drops a scan-code expression', () => {
    const design = { ...DERIVED_PAPER, derived: false };
    const terms = content({ ...design, terms: 'Terms: {{terms}}' }).terms;
    expect(terms).toBe('Terms:');
    const withInput = paperContent({
      passJson: EVENT_PASS,
      manifest: EVENT_MANIFEST,
      personalization: { terms: 'No refunds.' },
      design: { ...design, terms: '{{terms}}' },
    });
    expect(withInput.terms).toBe('No refunds.');
    const scanCode = paperContent({
      passJson: EVENT_PASS,
      manifest: EVENT_MANIFEST,
      personalization: {},
      design: { ...design, terms: '{{pass.scanCode}}' },
    });
    expect(scanCode.terms).toBeUndefined();
  });

  it('uses the holder name only when the pass names no attendee', () => {
    expect(content(DERIVED_PAPER, 'Grace').holder).toBe('Ada Lovelace');
  });
});

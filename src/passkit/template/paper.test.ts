import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { validateManifest } from './manifest.ts';
import { DERIVED_PAPER, PAPER_SPECS, paperManifestIssues, resolvePaper } from './paper.ts';
import { paperContent } from './paper-content.ts';
import { EVENT_MANIFEST, EVENT_PASS } from './paper-fixtures.ts';
import { overlaps, paperBoxes } from './paper-geometry.ts';

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

  it('lets paper print the lookup value only when the template declares it public', () => {
    const base = { schema: 1, size: 'a4', barcode: 'qr' };
    const lookup = (value: unknown) =>
      ({
        ...EVENT_MANIFEST,
        scan: { lookup: { input: 'ticketNo', ...(value === undefined ? {} : { public: value }) } },
        paper: { ...base, terms: 'No. {{ticketNo}}', fields: ['order'] },
      }) as unknown as TemplateManifest;
    const codesOf = (m: TemplateManifest) =>
      paperManifestIssues(m, { passJson: EVENT_PASS }).map((i) => i.code);
    expect(codesOf(lookup(undefined))).toContain('PAPER_LOOKUP_FIELD');
    expect(codesOf(lookup(false))).toContain('PAPER_LOOKUP_FIELD');
    expect(codesOf(lookup(true))).not.toContain('PAPER_LOOKUP_FIELD');
    // The scan code stays private whatever the lookup says.
    const scanCode = {
      ...lookup(true),
      paper: { ...base, terms: '{{pass.scanCode}}' },
    } as unknown as TemplateManifest;
    expect(codesOf(scanCode)).toContain('PAPER_SCAN_CODE');
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

  it('accepts kind, ink, fold, bring and buddy, and refuses bad values', () => {
    const base = { schema: 1, size: 'a4', barcode: 'qr' };
    expect(
      codes({ ...base, kind: 'permit', ink: 'mono', fold: false, bring: 'Water', buddy: true }),
    ).toEqual([]);
    expect(codes({ ...base, kind: 'ticket' })).toEqual(['PAPER_KIND']);
    expect(codes({ ...base, ink: 'sepia' })).toEqual(['PAPER_INK']);
    expect(codes({ ...base, bring: 'Code {{pass.scanCode}}' })).toContain('PAPER_SCAN_CODE');
    expect(codes({ ...base, bring: 'No. {{ticketNo}}' })).toContain('PAPER_LOOKUP_FIELD');
  });

  it('warns when the pass colours do not survive black and white', () => {
    const pastel = {
      ...EVENT_PASS,
      backgroundColor: 'rgb(206,242,226)',
      foregroundColor: 'rgb(12,52,38)',
    };
    const base = withPaper({ schema: 1, size: 'a4', barcode: 'qr' });
    expect(paperManifestIssues(base, { passJson: pastel }).map((i) => i.code)).toEqual([
      'PAPER_INK',
    ]);
    const mono = withPaper({ schema: 1, size: 'a4', barcode: 'qr', ink: 'mono' });
    expect(paperManifestIssues(mono, { passJson: pastel })).toEqual([]);
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
      ink: 'colour',
      fold: true,
      buddy: false,
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

  it('reads title, times, venue, holder, type and seat from the roles', () => {
    expect(content()).toMatchObject({
      brand: 'Northwind Hall',
      kind: 'admission',
      title: 'Spring Concert',
      start: '2027-04-12T19:30:00-05:00',
      zone: '-05:00',
      venue: 'Northwind Hall',
      holder: 'Ada Lovelace',
      type: 'General admission',
      seat: { section: 'B', row: '4', seat: '12' },
      facts: [
        { label: 'Section', text: 'B' },
        { label: 'Row', text: '4' },
        { label: 'Seat', text: '12' },
      ],
    });
  });

  it('says the venue once when the address repeats it', () => {
    const passJson = {
      ...EVENT_PASS,
      semantics: {
        ...EVENT_PASS.semantics,
        venueName: 'Grand Hall',
        venueRoom: 'Grand Hall',
        venueRegionName: 'Portland',
      },
    } as typeof EVENT_PASS;
    const c = paperContent({
      passJson,
      manifest: EVENT_MANIFEST,
      personalization: { name: 'Ada', ticketNo: 'T-77' },
      design: DERIVED_PAPER,
    });
    const lines = [c.venue, c.address, c.room].filter(Boolean);
    expect(c.venue).toBe('Grand Hall');
    expect(c.address).toBe('Portland');
    expect(new Set(lines).size).toBe(lines.length);
    expect(JSON.stringify(c).match(/Grand Hall/g)).toHaveLength(1);
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

describe('half sheet cameo and the PassBook credit', () => {
  const W = PAPER_SPECS.half.widthMm;
  const H = PAPER_SPECS.half.heightMm;
  // The footer row's meta text stops before the credit (about 26 mm and a 6 mm gap) and the cameo's 16 mm reserve.
  const meta = (mark: 'full' | 'small' | 'none') => ({
    x: 12,
    y: H - 8 - 16,
    w: W - 24 - (mark === 'none' ? 0 : 32) - 16,
    h: 16,
  });

  it('sits left of the credit when there is one, and at the right edge at none', () => {
    const full = paperBoxes('half', 'admission', { buddy: true, mark: 'full' }).buddy;
    const none = paperBoxes('half', 'admission', { buddy: true, mark: 'none' }).buddy;
    expect(full).toBeDefined();
    expect(none).toBeDefined();
    expect((none?.x ?? 0) + (none?.w ?? 0)).toBeCloseTo(W - 12);
    expect(none?.x).toBeGreaterThan(full?.x ?? 0);
  });

  it('never overlaps the meta text, with a long help line, at any mark', () => {
    for (const mark of ['full', 'small', 'none'] as const) {
      const buddy = paperBoxes('half', 'admission', { buddy: true, mark }).buddy;
      expect(buddy && overlaps(buddy, meta(mark))).toBe(false);
    }
  });
});

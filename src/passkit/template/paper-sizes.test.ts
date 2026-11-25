import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import {
  CODE128_MIN_MM,
  PAPER_SIZES,
  PAPER_SPECS,
  type PaperSize,
  paperManifestIssues,
  resolvePaper,
  supportsCode128,
} from './paper.ts';
import { overlaps, paperBoxes, QR_QUIET_MODULES, sheetLayout } from './paper-geometry.ts';
import { halfFit } from './paper-geometry-sizes.ts';
import { usesLetter, withRegionSize } from './paper-region.ts';

const NEW: PaperSize[] = ['cr80p', 'stub', 'atb', 'a6', 'dl', 'half-letter'];
const inside = (inner: { x: number; y: number; w: number; h: number }, outer: typeof inner) =>
  inner.x >= outer.x - 0.001 &&
  inner.y >= outer.y - 0.001 &&
  inner.x + inner.w <= outer.x + outer.w + 0.001 &&
  inner.y + inner.h <= outer.y + outer.h + 0.001;

describe('new sizes', () => {
  it('have their physical sizes', () => {
    const dims = (s: PaperSize) => [PAPER_SPECS[s].widthMm, PAPER_SPECS[s].heightMm];
    expect(dims('cr80p')).toEqual([54, 85.6]);
    expect(dims('stub')).toEqual([139.7, 50.8]);
    expect(dims('atb')).toEqual([203.2, 82.55]);
    expect(dims('a6')).toEqual([148, 105]);
    expect(dims('dl')).toEqual([210, 99]);
    expect(dims('half-letter')).toEqual([215.9, 139.7]);
  });

  it.each(PAPER_SIZES)(
    '%s: QR at least 30 mm, Code 128 only where it prints at 203 dpi',
    (size) => {
      const spec = PAPER_SPECS[size];
      expect(spec.qrMm).toBeGreaterThanOrEqual(30);
      expect(supportsCode128(size)).toBe(spec.barMm >= CODE128_MIN_MM);
      if (spec.layout === 'strip' || spec.layout === 'card')
        expect(spec.barMm === 0 || spec.barMm >= 83).toBe(true);
    },
  );

  it.each(NEW)(
    '%s: the code and its quiet zone sit inside the ticket, nothing overlaps',
    (size) => {
      const spec = PAPER_SPECS[size];
      const boxes = paperBoxes(size, 'admission', { barcode: 'qr' });
      const modules = 25;
      const whole = (spec.qrMm * (modules + 2 * QR_QUIET_MODULES)) / modules;
      expect(boxes.code.w).toBeCloseTo(whole, 3);
      expect(inside(boxes.code, boxes.ticket ?? boxes.page)).toBe(true);
      if (boxes.door && boxes.face) expect(overlaps(boxes.door, boxes.face)).toBe(false);
      if (boxes.typed) {
        expect(overlaps(boxes.typed, boxes.code)).toBe(false);
        expect(inside(boxes.typed, boxes.door ?? boxes.page)).toBe(true);
      }
      if (spec.layout === 'strip') {
        expect(boxes.face?.w).toBeGreaterThan(70);
        expect(boxes.code.x).toBeGreaterThanOrEqual((boxes.door?.x ?? 0) - 0.001);
      }
    },
  );

  it('the stub puts the code beside the text, the others under it the typed line', () => {
    expect(paperBoxes('stub', 'admission').typed).toBeUndefined();
    for (const size of ['atb', 'a6', 'dl'] as const)
      expect(paperBoxes(size, 'admission').typed).toBeDefined();
  });

  it.each(['atb', 'dl'] as const)('%s fits Code 128 at 0.25 mm bars', (size) => {
    const boxes = paperBoxes(size, 'admission', { barcode: 'code128' });
    expect(boxes.code.w).toBeGreaterThan(83);
    expect(inside(boxes.code, boxes.ticket ?? boxes.page)).toBe(true);
    expect(boxes.face?.w).toBeGreaterThan(80);
  });

  it('a portrait card has its code centred at the foot, a landscape one at the right', () => {
    const p = paperBoxes('cr80p', 'admission').code;
    expect(p.x + p.w / 2).toBeCloseTo(27, 2);
    expect(p.y + p.h).toBeLessThan(85.6);
    const l = paperBoxes('cr80', 'admission').code;
    expect(l.x).toBeGreaterThan(40);
  });

  it('half letter keeps the half-sheet layout inside its page', () => {
    const b = paperBoxes('half-letter', 'admission');
    expect(inside(b.ticket ?? b.page, b.page)).toBe(true);
    expect(inside(b.code, b.door ?? b.page)).toBe(true);
    const fit = halfFit('half-letter');
    expect(210 * fit.scale + 2 * fit.dx).toBeCloseTo(215.9, 3);
    expect(148 * fit.scale).toBeLessThanOrEqual(139.7 + 0.001);
  });
});

describe('cards on a home sheet', () => {
  it.each([
    ['cr80', 'a4'],
    ['cr80', 'letter'],
    ['cr80p', 'a4'],
    ['cr80p', 'letter'],
  ] as const)('%s on %s: two faces and eight cut ticks, inside the sheet', (size, sheet) => {
    const l = sheetLayout(size, sheet);
    expect(l.cards).toHaveLength(2);
    expect(overlaps(l.cards[0], l.cards[1])).toBe(false);
    for (const c of l.cards) expect(inside(c, l.page)).toBe(true);
    expect(l.cuts).toHaveLength(16);
    for (const [x1, y1, x2, y2] of l.cuts) {
      expect(
        inside(
          { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
          l.page,
        ),
      ).toBe(true);
      // A tick never crosses a card.
      const tick = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1) || 0.01,
        h: Math.abs(y2 - y1) || 0.01,
      };
      for (const c of l.cards) expect(overlaps(tick, c)).toBe(false);
    }
  });
});

describe('schema', () => {
  const manifest = (paper: object) => ({ name: 'x', paper }) as unknown as TemplateManifest;

  it.each(PAPER_SIZES)('accepts %s', (size) => {
    expect(paperManifestIssues(manifest({ schema: 1, size, barcode: 'qr' }))).toEqual([]);
    expect(resolvePaper({ schema: 1, size, barcode: 'qr' }).size).toBe(size);
  });

  it('rejects Code 128 where it does not fit, and draws QR', () => {
    for (const size of ['cr80', 'cr80p', 'stub', 'a6'] as const) {
      const issues = paperManifestIssues(manifest({ schema: 1, size, barcode: 'code128' }));
      expect(issues.map((i) => i.code)).toContain('PAPER_BARCODE');
      expect(resolvePaper({ schema: 1, size, barcode: 'code128' }).barcode).toBe('qr');
    }
    for (const size of ['atb', 'dl', 'half-letter'] as const)
      expect(resolvePaper({ schema: 1, size, barcode: 'code128' }).barcode).toBe('code128');
  });

  it('keeps sheet on cards only', () => {
    expect(resolvePaper({ schema: 1, size: 'cr80p', barcode: 'qr', sheet: 'letter' }).sheet).toBe(
      'letter',
    );
    expect(
      resolvePaper({ schema: 1, size: 'atb', barcode: 'qr', sheet: 'letter' }).sheet,
    ).toBeUndefined();
    expect(
      paperManifestIssues(manifest({ schema: 1, size: 'atb', barcode: 'qr', sheet: 'a4' })).map(
        (i) => i.code,
      ),
    ).toContain('PAPER_SHEET');
    expect(
      paperManifestIssues(manifest({ schema: 1, size: 'cr80', barcode: 'qr', sheet: 'a3' })).map(
        (i) => i.code,
      ),
    ).toContain('PAPER_SHEET');
  });
});

describe('region default', () => {
  it('prints derived designs on Letter for US and Canadian zones, A4 elsewhere', () => {
    const derived = resolvePaper(undefined);
    expect(withRegionSize(derived, 'America/Chicago').size).toBe('letter');
    expect(withRegionSize(derived, 'America/Indiana/Knox').size).toBe('letter');
    expect(withRegionSize(derived, 'America/Toronto').size).toBe('letter');
    expect(withRegionSize(derived, 'Europe/Berlin').size).toBe('a4');
    expect(withRegionSize(derived, 'America/Sao_Paulo').size).toBe('a4');
    expect(withRegionSize(derived, undefined).size).toBe('a4');
    expect(usesLetter('Pacific/Honolulu')).toBe(true);
  });

  it('never overrides a size the template chose', () => {
    const chosen = resolvePaper({ schema: 1, size: 'a4', barcode: 'qr' });
    expect(withRegionSize(chosen, 'America/New_York').size).toBe('a4');
  });
});

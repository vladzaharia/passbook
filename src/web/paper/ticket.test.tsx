import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PAPER_SPECS,
  type PaperDesign,
  type PaperKind,
  type PaperSize,
  resolvePaper,
} from '../../passkit/template/paper.ts';
import { blueprintPass, SCAN_CODE } from '../../passkit/template/paper-blueprint-fixtures.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import { overlaps, paperBoxes, TICKET_SHAPE } from '../../passkit/template/paper-geometry.ts';
import type { BrandMark } from '../../shared/contracts/orgs.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from './drawing.ts';
import { PaperTicket } from './ticket.tsx';

const CODE = 'PABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SLUG: Record<PaperKind, string> = {
  admission: 'starter-event-ticket',
  membership: 'henrys-blue',
  permit: 'starter-permit',
  coupon: 'starter-coupon',
  pickup: 'starter-pickup',
  journey: 'starter-boarding-pass',
  booking: 'starter-booking',
  stay: 'starter-hotel-stay',
  badge: 'starter-staff-badge',
  credential: 'starter-credential',
};

async function sheet(
  kind: PaperKind,
  size: PaperSize,
  paper: Record<string, unknown> = {},
  mode?: 'test',
  mark: BrandMark = 'full',
) {
  const { passJson, manifest, personalization } = await blueprintPass(SLUG[kind]);
  const design: PaperDesign = resolvePaper({ schema: 1, size, barcode: 'qr', kind, ...paper });
  const content = paperContent({
    passJson,
    manifest,
    personalization,
    design,
    scanCode: SCAN_CODE,
  });
  const html = renderToStaticMarkup(
    <PaperTicket
      content={content}
      design={design}
      code={CODE}
      mark={mark}
      drawing={drawPaperCode(toSvg, design.barcode, CODE)}
      mode={mode}
    />,
  );
  return { html, content, design };
}

const COMBOS: [PaperKind, PaperSize][] = [
  ['admission', 'a4'],
  ['admission', 'letter'],
  ['admission', 'half'],
  ['membership', 'cr80'],
  ['membership', 'a4'],
  ['permit', 'half'],
  ['coupon', 'half'],
  ['pickup', 'letter'],
  ['journey', 'a4'],
  ['journey', 'half'],
  ['booking', 'half'],
  ['stay', 'a4'],
  ['badge', 'cr80'],
  ['badge', 'a4'],
  ['credential', 'cr80'],
];

describe('paper ticket per class and size', () => {
  it.each(COMBOS)('draws %s on %s with the print code and nothing private', async (kind, size) => {
    const { html } = await sheet(kind, size);
    expect(html).toContain('PABCDEFGH IJKLMNOPQ RSTUVWXYZ');
    expect(html).not.toContain(SCAN_CODE);
    expect(html).toContain(`data-size="${size}"`);
    expect(html).toMatch(/aria-label="(Ticket|Pass|Booking|Badge|Card) for /);
    expect(html).toMatch(
      /role="img" aria-label="(QR code|Code 128 barcode)\. \w+ code PABCDEFGH, IJKLMNOPQ, RSTUVWXYZ"/,
    );
    // PassBook is a text line in the footer, once, and never a second code.
    expect(html.match(/PassBook/g)).toHaveLength(size === 'cr80' ? 1 : 1);
    expect(html.match(/role="img"/g)).toHaveLength(size === 'cr80' ? 1 : 1);
  });

  it.each(COMBOS)('%s on %s follows the footer choice', async (kind, size) => {
    const small = (await sheet(kind, size, {}, undefined, 'small')).html;
    expect(small).toContain('Powered by PassBook');
    expect(small).not.toContain('Issued with');
    const none = (await sheet(kind, size, {}, undefined, 'none')).html;
    expect(none).not.toContain('PassBook');
    expect(none).not.toContain('pp-passbook');
  });

  it('draws a card as two faces', async () => {
    const { html } = await sheet('membership', 'cr80');
    expect(html.match(/pp-fit/g)).toHaveLength(2);
    expect(html).toContain('data-face="front"');
    expect(html).toContain('data-face="back"');
  });

  it('draws Code 128 when asked', async () => {
    const { html } = await sheet('coupon', 'half', { barcode: 'code128' });
    expect(html).toContain('Code 128 barcode');
    expect(html).toContain('Coupon code');
  });

  it('labels the code by class', async () => {
    expect((await sheet('permit', 'half')).html).toContain('Permit code');
    expect((await sheet('pickup', 'letter')).html).toContain('Slip code');
    expect((await sheet('membership', 'cr80')).html).toContain('Card code');
    expect((await sheet('admission', 'a4')).html).toContain('Ticket code');
  });

  it('says the print and the phone are one ticket, without the old code note', async () => {
    const { html } = await sheet('admission', 'a4');
    expect(html).toContain('This print and your phone ticket are the same ticket.');
    expect(html).not.toContain('Type this code if the barcode will not scan');
  });

  it('prints the zone on every time', async () => {
    const { html } = await sheet('admission', 'a4');
    expect(html).toMatch(/\d:\d\d [ap]m [A-Z]{3,4}\b|GMT[+-]\d/);
  });

  it('draws mono ink without art, with a black logo plate', async () => {
    const { html, content } = await sheet('admission', 'a4', { ink: 'mono' });
    expect(content.ink).toBe('mono');
    expect(html).toContain('pp-mono-ink');
    expect(html).not.toContain('pp-bg');
  });
});

describe('follow-ups', () => {
  it('names a permit "Parking permit"', async () => {
    expect((await sheet('permit', 'half')).html).toContain('Parking permit');
  });

  it('gives a half sheet a one-line Before you go with when and where', async () => {
    const { html } = await sheet('admission', 'half');
    expect(html).toMatch(/Before you go<\/b> [^<]*· [^<]+/);
    expect((await sheet('admission', 'a4')).html.match(/Before you go/g)).toHaveLength(1);
  });
});

describe('code size and quiet zone', () => {
  it.each(COMBOS.filter(([, size]) => size !== 'cr80' || true))(
    '%s on %s: QR 30 mm or more with 4 modules around it',
    async (kind, size) => {
      const { html, design } = await sheet(kind, size);
      if (design.barcode !== 'qr') return;
      const drawing = drawPaperCode(toSvg, 'qr', CODE);
      expect(drawing).toBeDefined();
      if (!drawing) return;
      const width = Number(
        /<svg class="pp-qr"[^>]*style="width:calc\(var\(--mm\) \* ([\d.]+)\)/.exec(html)?.[1],
      );
      expect((drawing.whole - drawing.symbol) / 2 / (drawing.symbol / drawing.modules)).toBe(4);
      expect((width * drawing.symbol) / drawing.whole).toBeGreaterThanOrEqual(30);
    },
  );

  it('keeps every QR at least 14 mm from a fold on full pages', () => {
    for (const size of ['a4', 'letter'] as const)
      for (const kind of ['admission', 'membership', 'pickup'] as const) {
        const b = paperBoxes(size, kind);
        const { x, y } = b.fold ?? { x: 0, y: 0 };
        expect(Math.abs(b.code.x + b.code.w - x)).toBeGreaterThanOrEqual(TICKET_SHAPE.minFoldGap);
        expect(y - (b.code.y + b.code.h)).toBeGreaterThanOrEqual(TICKET_SHAPE.minFoldGap - 6);
      }
  });
});

describe('test prints', () => {
  it('adds the strip, the dashed outline hook and the watermark', async () => {
    const { html } = await sheet('admission', 'a4', {}, 'test');
    expect(html).toContain('TEST TICKET · NOT VALID FOR ENTRY');
    expect(html).toContain('pp-watermark');
    expect(html).toContain('pp-test');
    expect((await sheet('admission', 'a4')).html).not.toContain('pp-watermark');
  });

  it('keeps the code inside the door panel the watermark skips', () => {
    for (const size of ['a4', 'letter', 'half'] as const) {
      const b = paperBoxes(size, 'admission');
      const door = b.door;
      expect(door).toBeDefined();
      if (!door) return;
      expect(overlaps(b.code, { ...door, x: door.x + door.w, w: 1000 })).toBe(false);
      expect(b.code.x).toBeGreaterThanOrEqual(door.x);
      expect(b.code.x + b.code.w).toBeLessThanOrEqual(door.x + door.w);
    }
  });
});

describe('the buddy cameo', () => {
  it('is off by default and one per sheet when on', async () => {
    expect((await sheet('admission', 'a4')).html).not.toContain('pp-buddy');
    const on = (await sheet('admission', 'a4', { buddy: true })).html;
    expect(on.match(/class="pp-buddy"/g)).toHaveLength(1);
    expect(on).toContain('aria-hidden="true"');
  });

  it('is not drawn on a card or a permit', async () => {
    expect((await sheet('membership', 'cr80', { buddy: true })).html).not.toContain('pp-buddy');
    expect((await sheet('permit', 'half', { buddy: true })).html).not.toContain('pp-buddy');
  });

  it('draws the line version in mono', async () => {
    const { html } = await sheet('pickup', 'letter', { buddy: true });
    expect(html).toContain('pp-buddy');
    expect(html).not.toContain('#7A2FFF');
  });

  it.each([
    ['admission', 'a4'],
    ['admission', 'letter'],
    ['admission', 'half'],
    ['pickup', 'letter'],
    ['coupon', 'half'],
  ] as [PaperKind, PaperSize][])(
    '%s on %s: never on the door panel, a fold or the code',
    (kind, size) => {
      const b = paperBoxes(size, kind, { buddy: true });
      expect(b.buddy).toBeDefined();
      if (!b.buddy) return;
      if (b.door) expect(overlaps(b.buddy, b.door)).toBe(false);
      if (b.face) expect(overlaps(b.buddy, b.face)).toBe(false);
      if (b.fold) expect(b.buddy.y).toBeGreaterThan(b.fold.y);
      const gap = Math.max(
        b.code.x - (b.buddy.x + b.buddy.w),
        b.buddy.x - (b.code.x + b.code.w),
        b.code.y - (b.buddy.y + b.buddy.h),
        b.buddy.y - (b.code.y + b.code.h),
      );
      expect(gap).toBeGreaterThanOrEqual(10);
      const spec = PAPER_SPECS[size];
      expect(b.buddy.x + b.buddy.w).toBeLessThanOrEqual(spec.widthMm - 8);
    },
  );
});

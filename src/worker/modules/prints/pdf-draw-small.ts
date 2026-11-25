/** Permit: the half-sheet design (the coupon's is in pdf-draw-coupon.ts). On A4 or Letter they sit on the top half, as on the print page. */
import { PAPER_SPECS } from '../../../passkit/template/paper.ts';
import { paperBoxes } from '../../../passkit/template/paper-geometry.ts';
import { PAPER_COPY } from '../../../shared/copy/print.ts';
import { endsText, footMeta, rangeText } from '../../../web/paper/ticket-text.ts';
import { codeMark, LBL, META, passbookLine, plate, typedCode } from './pdf-draw-parts.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';
import { testStrip, watermark } from './pdf-test-mark.ts';

export const HALF = PAPER_SPECS.half;
export const PAGE = { w: HALF.widthMm, h: HALF.heightMm };

/** A tile or band in the pass colour; white with an ink rule in mono. Returns the foreground colour. */
export function tile(pen: Pen, s: Sheet, b: Box, r: number): string {
  const c = s.content;
  if (c.ink === 'mono') {
    pen.fillStrokeBox(
      { x: b.x + 0.175, y: b.y + 0.175, w: b.w - 0.35, h: b.h - 0.35 },
      COLORS.white,
      COLORS.ink,
      0.35,
      r - 0.175,
    );
    return COLORS.ink;
  }
  pen.fillBox(b, c.colors.bg, r);
  return c.colors.fg;
}

export function stack(
  items: { h: number; draw: (y: number) => void }[],
  top: number,
  h: number,
  gap: number,
) {
  const total = items.reduce((n, i) => n + i.h, 0) + gap * (items.length - 1);
  let y = top + (h - total) / 2;
  for (const i of items) {
    i.draw(y);
    y += i.h + gap;
  }
}

export function drawPermit(pen: Pen, s: Sheet): void {
  const c = s.content;
  const mono = c.ink === 'mono';
  const test = s.mode === 'test';
  const boxes = paperBoxes('half', 'permit', { barcode: s.drawing?.kind ?? 'qr' });
  const inner = PAGE.w - 16;
  const band: Box = { x: 8, y: 8, w: inner, h: 19 };
  const fg = tile(pen, s, band, 3);
  plate(pen, s, { x: 13, y: 11.5 }, 12, { color: '#000000', opacity: 0.18 });
  const org: TextStyle = { size: 3.5278, font: 'semibold', color: fg };
  pen.text(c.brand, c.logo ? 28 : 13, band.y + (band.h - pen.lineHeight(org)) / 2, org);
  const kicker: TextStyle = { ...LBL, color: mono ? COLORS.muted : c.colors.label };
  const type: TextStyle = { size: 5.2917, font: 'semibold', color: fg, lh: 1.05 };
  const right = band.x + band.w - 5;
  const kh = pen.lineHeight(kicker) + (c.type ? pen.lineHeight(type) : 0);
  const k0 = band.y + (band.h - kh) / 2;
  pen.text([c.kicker, c.venue].filter(Boolean).join(' · '), right - 120, k0, kicker, 'right', 120);
  if (c.type) pen.text(c.type, right - 120, k0 + pen.lineHeight(kicker), type, 'right', 120);

  const main = { y: 31, h: 84 };
  const zone = c.hero?.zone;
  if (zone) {
    const t: Box = { x: 8, y: main.y, w: 44, h: main.h };
    const zfg = tile(pen, s, t, 3);
    const zk: TextStyle = {
      size: 3.8806,
      font: 'semibold',
      color: mono ? COLORS.muted : c.colors.label,
      ls: 0.16,
    };
    let zv: TextStyle = { size: 39.5111, font: 'bold', color: zfg, lh: 0.95 };
    const fit = 40 / Math.max(40, pen.measure(zone, zv));
    zv = { ...zv, size: zv.size * fit };
    const h = pen.lineHeight(zk) + pen.lineHeight(zv);
    const y = t.y + (t.h - h) / 2;
    pen.text('ZONE', t.x, y, zk, 'center', t.w);
    pen.text(zone, t.x, y + pen.lineHeight(zk), zv, 'center', t.w);
  }
  const midX = zone ? 8 + 44 + 6 : 8;
  const midW = zone ? inner - 44 - 54 - 12 : inner - 54 - 6;
  const bay = c.facts.find((f) => f.label === 'Bay');
  const ends = endsText(c);
  const range = rangeText(c);
  const lblH = pen.lineHeight(LBL);
  const items: { h: number; draw: (y: number) => void }[] = [];
  if (c.hero?.plate) {
    let ps: TextStyle = { size: 12.7, font: 'bold', color: COLORS.ink, ls: 0.03, lh: 1 };
    const plateW = (st: TextStyle) => pen.measure(c.hero?.plate ?? '', st) + 7 + 1.2;
    if (plateW(ps) > midW) ps = { ...ps, size: (ps.size * midW) / plateW(ps) };
    const ph = ps.size + 4 + 1.2;
    items.push({
      h: lblH + 1 + ph,
      draw: (y) => {
        pen.text('Vehicle', midX, y, LBL);
        const b = { x: midX, y: y + lblH + 1, w: plateW(ps), h: ph };
        pen.strokeBox(
          { x: b.x + 0.3, y: b.y + 0.3, w: b.w - 0.6, h: b.h - 0.6 },
          COLORS.ink,
          0.6,
          2.2,
        );
        pen.text(c.hero?.plate ?? '', b.x + 3.5 + 0.6, b.y + 2 + 0.6, ps);
      },
    });
  }
  if (range) {
    const until: TextStyle = { size: 7.7611, font: 'bold', color: COLORS.ink, lh: 1.05 };
    const lines = pen.wrap(range, midW, until, 2);
    items.push({
      h: lblH + lines.length * pen.lineHeight(until),
      draw: (y) => {
        pen.text('Valid', midX, y, LBL);
        for (const [i, l] of lines.entries())
          pen.text(l, midX, y + lblH + i * pen.lineHeight(until), until);
      },
    });
  }
  const row = [bay && ['Bay', bay.text], ends && ['Ends', ends]].filter(Boolean) as [
    string,
    string,
  ][];
  if (row.length) {
    const v: TextStyle = { size: 4.2333, font: 'semibold', color: COLORS.ink };
    items.push({
      h: lblH + pen.lineHeight(v),
      draw: (y) => {
        let x = midX;
        for (const [l, t] of row) {
          pen.text(l, x, y, LBL);
          x += pen.text(t, x, y + lblH, v) + 8;
        }
      },
    });
  }
  stack(items, main.y, main.h, 4.5);

  const side: Box = { x: PAGE.w - 8 - 54, y: main.y, w: 54, h: main.h };
  pen.line(side.x + 0.15, side.y, side.x + 0.15, side.y + side.h, COLORS.hair, 0.3);
  const code = codeMark(pen, s, boxes.code, HALF);
  const cx = side.x + 0.3 + 2 + (side.w - 2.3) / 2;
  const mono28: TextStyle = { size: 2.8222, font: 'mono', color: COLORS.ink, ls: 0.03, lh: 1.35 };
  const ty = code.y + code.h + 0.6;
  typedCode(pen, s, cx, ty, mono28, { maxWidth: 36 });
  if (test) testStrip(pen, side.x + 2.3, code.y - 8, side.w - 2.6, 2.1);

  const foot = PAGE.h - 8 - 17;
  pen.line(8, foot + 0.15, 8 + inner, foot + 0.15, COLORS.hair, 0.3);
  const how: TextStyle = { size: 3.175, font: 'semibold', color: COLORS.ink };
  const fine: TextStyle = { size: 2.6811, font: 'regular', color: COLORS.muted };
  let y = foot + 0.3 + 2.4;
  y += pen.para(PAPER_COPY.permitHow, 8, y, 105, how, { maxLines: 2 }) + 0.6;
  const small = [c.terms, c.help.length ? `Questions: ${c.help.join(', ')}` : undefined]
    .filter(Boolean)
    .join(' ');
  if (small) pen.para(small, 8, y, 105, fine, { maxLines: 2 });
  const metaLine = [c.holder, footMeta(c, s.issued)].filter(Boolean).join(' · ');
  const mw = inner - 105 - 6;
  pen.text(
    pen.wrap(metaLine, mw, META, 1)[0] ?? '',
    8 + inner - mw,
    foot + 0.3 + 2.4,
    META,
    'right',
    mw,
  );
  passbookLine(pen, s.mark, 8 + inner, pen.baselineOf(META, foot + 17 - pen.lineHeight(META)));
  if (test) watermark(pen, PAGE, side, { size: 13, tops: [0.2, 0.5, 0.8] });
}

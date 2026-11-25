import { COUPON_BAND, paperBoxes } from '../../../passkit/template/paper-geometry.ts';
import { PAPER_COPY } from '../../../shared/copy/print.ts';
import { buddyPose } from '../../../web/paper/ticket-buddy.tsx';
import { footMeta, paperAt } from '../../../web/paper/ticket-text.ts';
import { drawBuddy } from './pdf-buddy.ts';
import { codeMark, LBL, META, passbookLine, plate, typedCode } from './pdf-draw-parts.ts';
import { HALF, PAGE, stack, tile } from './pdf-draw-small.ts';
import { type Box, COLORS, type Pen, PT, type TextStyle } from './pdf-kit.ts';
import type { PdfPicture } from './pdf-png.ts';
import type { Sheet } from './pdf-sheet.ts';
import { testStrip, watermark } from './pdf-test-mark.ts';

const SCISSORS = [
  'M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z',
  'M8.12 8.12L12 12',
  'M20 4L8.12 15.88',
  'M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z',
  'M14.8 14.8L20 20',
];

export function drawCoupon(pen: Pen, s: Sheet): void {
  const c = s.content;
  const mono = c.ink === 'mono';
  const test = s.mode === 'test';
  const boxes = paperBoxes('half', 'coupon', {
    barcode: s.drawing?.kind ?? 'code128',
    buddy: s.design.buddy,
  });
  pen.strokeBox(
    { x: 8.225, y: 8.225, w: PAGE.w - 16.45, h: PAGE.h - 16.45 },
    COLORS.rule,
    0.45,
    3.3,
    [1.4, 1],
  );
  pen.fillBox({ x: 16, y: 5.6, w: 7.2, h: 5 }, COLORS.white);
  for (const d of SCISSORS)
    pen.page.drawSvgPath(d, {
      x: pen.px(17.2),
      y: pen.py(5.7),
      scale: (4.8 / 24) * PT,
      borderColor: pen.color(COLORS.muted),
      borderWidth: 1.6,
    });
  const inner: Box = { x: 10.5, y: 10.5, w: PAGE.w - 21, h: PAGE.h - 21 };
  const band: Box = { ...inner, h: COUPON_BAND };
  const fg = tile(pen, s, band, 2.5);
  if (!mono && s.images.art && c.art)
    pen.clipped(band, () => pen.cover(s.images.art as PdfPicture, band, 1, 0.5), 2.5);
  plate(pen, s, { x: band.x + 5, y: band.y + 4 }, 9, { color: '#000000', opacity: 0.18 });
  const org: TextStyle = { size: 3.5278, font: 'semibold', color: fg };
  const kind: TextStyle = { ...LBL, color: mono ? COLORS.muted : c.colors.label };
  const lead = band.x + 5 + (c.logo ? 11.6 : 0);
  const pair = pen.lineHeight(org) + pen.lineHeight(kind);
  const top = band.y + 4 + (9 - pair) / 2;
  pen.text(c.brand, lead, top, org);
  pen.text(c.kicker, lead, top + pen.lineHeight(org), kind);

  const sentence = (t: string) => t.trim().replace(/\.+$/, '');
  const small = [c.terms, PAPER_COPY.reprints[1].split('. ')[0]]
    .filter((t): t is string => Boolean(t))
    .map(sentence)
    .join('. ');
  const fine: TextStyle = { size: 2.54, font: 'regular', color: COLORS.muted, lh: 1.35 };
  const pLines = pen.wrap(`${small}.`, 120, fine, 2);
  const meta: TextStyle = { ...META, size: 2.3283 };
  const footH = 0.25 + 2 + Math.max(pLines.length * pen.lineHeight(fine), 2 * pen.lineHeight(meta));
  const footTop = inner.y + inner.h - footH;
  const bodyTop = band.y + band.h + 4;
  const body = { y: bodyTop, h: footTop - 4 - bodyTop };
  const items: { h: number; draw: (y: number) => void }[] = [];
  const colW = inner.w - 97 - 6;
  if (c.hero?.offer) {
    let v: TextStyle = {
      size: 19.7556,
      font: 'bold',
      color: mono ? COLORS.ink : c.colors.bg,
      ls: -0.02,
      lh: 0.95,
    };
    v = { ...v, size: v.size * Math.min(1, colW / pen.measure(c.hero.offer, v)) };
    items.push({ h: pen.lineHeight(v), draw: (y) => pen.text(c.hero?.offer ?? '', inner.x, y, v) });
  }
  if (c.hero?.offerNote) {
    const note: TextStyle = { size: 5.6, font: 'medium', color: COLORS.ink };
    items.push({
      h: pen.paraHeight(c.hero.offerNote, colW, note, 2),
      draw: (y) => pen.para(c.hero?.offerNote ?? '', inner.x, y, colW, note, { maxLines: 2 }),
    });
  }
  if (c.info.pack && c.holder) {
    const note: TextStyle = { size: 5.6, font: 'medium', color: COLORS.ink };
    const line = `For ${c.holder}`;
    items.push({
      h: pen.paraHeight(line, colW, note, 1),
      draw: (y) => pen.para(line, inner.x, y, colW, note, { maxLines: 1 }),
    });
  }
  if (c.validUntil) {
    const date = paperAt(c, c.validUntil, 'short');
    const dst: TextStyle = { size: 4.6, font: 'semibold', color: COLORS.ink };
    const ust: TextStyle = { ...LBL, color: COLORS.ink };
    const w = 2.4 * 2 + 0.8 + pen.measure('Use by', ust) + 2 + pen.measure(date, dst);
    const h = 0.8 + 2.4 + pen.lineHeight(dst);
    items.push({
      h: h + 1,
      draw: (y) => {
        const b = { x: inner.x, y: y + 1, w, h };
        pen.strokeBox(
          { x: b.x + 0.2, y: b.y + 0.2, w: b.w - 0.4, h: b.h - 0.4 },
          COLORS.ink,
          0.4,
          1.3,
        );
        const base = pen.baselineOf(dst, b.y + 0.4 + 1.2);
        pen.text('Use by', b.x + 0.4 + 2.4, pen.topFor(ust, base), ust);
        pen.text(date, b.x + 0.4 + 2.4 + pen.measure('Use by', ust) + 2, b.y + 0.4 + 1.2, dst);
      },
    });
  }
  stack(items, body.y, body.h, 3.5);
  const code = codeMark(pen, s, boxes.code, HALF);
  typedCode(pen, s, code.x + code.w / 2, code.y + code.h + 1.4, {
    size: 3.175,
    font: 'mono',
    color: COLORS.ink,
    ls: 0.04,
    lh: 1.3,
  });
  if (test) testStrip(pen, code.x + 7, code.y - 9, code.w - 14);

  pen.line(inner.x, footTop + 0.125, inner.x + inner.w, footTop + 0.125, COLORS.hair, 0.25);
  const fy = footTop + 0.25 + 2;
  for (const [i, l] of pLines.entries()) pen.text(l, inner.x, fy + i * pen.lineHeight(fine), fine);
  pen.text(footMeta(c, s.issued), inner.x + inner.w - 80, fy, meta, 'right', 80);
  passbookLine(
    pen,
    s.mark,
    inner.x + inner.w,
    pen.baselineOf(meta, fy + pen.lineHeight(meta)),
    2.3283,
  );
  const pose = s.design.buddy ? buddyPose(c.kind, c.noun) : null;
  if (boxes.buddy && pose) drawBuddy(pen, boxes.buddy, pose, mono);
  if (test)
    watermark(
      pen,
      PAGE,
      { x: code.x, y: code.y - 9, w: code.w, h: code.h + 20 },
      { size: 13, tops: [0.2, 0.5, 0.8] },
    );
}

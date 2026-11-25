/** CR80 card: the front in the pass colour with the code on a white tile, a white back with the typed code. */

import { paperBoxes } from '../../../passkit/template/paper-geometry.ts';
import { PAPER_COPY } from '../../../shared/copy/print.ts';
import { footMeta, paperAt } from '../../../web/paper/ticket-text.ts';
import { codeMark, LBL, passbookLine, plate, specOf, typedCode } from './pdf-draw-parts.ts';
import { fadeState } from './pdf-gstate.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';
import { watermark } from './pdf-test-mark.ts';

const W = 85.6;
const H = 54;

export function drawCardFront(pen: Pen, s: Sheet): void {
  const c = s.content;
  const mono = c.ink === 'mono';
  const member = c.kind === 'membership';
  const page: Box = { x: 0, y: 0, w: W, h: H };
  const fg = mono ? COLORS.ink : c.colors.fg;
  if (!mono) {
    pen.fillBox(page, c.colors.bg);
    if (s.images.art && c.art) {
      pen.cover(s.images.art, page, 0.5, 0.5, 0.28);
      const mask = fadeState(pen.page, { x0: pen.px(W * 0.3), x1: pen.px(W), a0: 1, a1: 0.55 }, [
        0,
        0,
        pen.px(W),
        pen.py(0),
      ]);
      pen.fillMasked(page, c.colors.bg, mask);
    }
  }
  const x = 4;
  const logo = s.images.logo;
  if (c.logo && logo && !mono) {
    const w = 24;
    pen.image(logo, { x, y: 4, w, h: Math.min(20, (w * logo.height) / logo.width) });
  } else plate(pen, s, { x, y: 4 }, 9);
  const kicker: TextStyle = {
    size: 1.7639,
    font: 'medium',
    color: mono ? COLORS.muted : c.colors.label,
    ls: 0.1,
    upper: true,
  };
  const name: TextStyle = { size: 3.5278, font: 'semibold', color: fg, lh: 1.1 };
  const tierSt: TextStyle = { size: 2.3283, font: 'regular', color: fg };
  const tier = (
    member
      ? [c.type, c.venue]
      : [c.start ? paperAt(c, c.start, 'short') : undefined, c.venue, c.holder]
  )
    .filter(Boolean)
    .join(' · ');
  const nameLines = pen.wrap(member ? (c.holder ?? c.title) : c.title, 37, name, 3);
  const tierLines = tier ? pen.wrap(tier, 37, tierSt, 2) : [];
  const blockH =
    pen.lineHeight(kicker) +
    0.6 +
    nameLines.length * pen.lineHeight(name) +
    (tierLines.length ? 0.8 + tierLines.length * pen.lineHeight(tierSt) : 0);
  let y = H - 4 - blockH;
  pen.text(member ? 'Member' : c.kicker, x, y, kicker);
  y += pen.lineHeight(kicker) + 0.6;
  for (const l of nameLines) {
    pen.text(l, x, y, name);
    y += pen.lineHeight(name);
  }
  y += 0.8;
  for (const l of tierLines) {
    pen.text(l, x, y, tierSt);
    y += pen.lineHeight(tierSt);
  }
  const code = paperBoxes('cr80', c.kind, {}).code;
  pen.fillBox(code, COLORS.white, 2);
  if (mono)
    pen.strokeBox(
      { x: code.x - 0.175, y: code.y - 0.175, w: code.w + 0.35, h: code.h + 0.35 },
      COLORS.ink,
      0.35,
      2.2,
    );
  codeMark(pen, s, code, specOf(s), 2);
  if (s.mode === 'test') watermark(pen, { w: W, h: H }, code, { size: 6, tops: [0.18, 0.5, 0.82] });
}

export function drawCardBack(pen: Pen, s: Sheet): void {
  const c = s.content;
  const x = 4;
  const w = W - 8;
  let y = 3.6;
  plate(pen, s, { x, y }, 6);
  const org: TextStyle = {
    size: 1.9756,
    font: 'semibold',
    color: COLORS.muted,
    ls: 0.06,
    upper: true,
  };
  const label = c.kind === 'membership' ? 'Membership card' : c.kicker;
  pen.text(label, x, y + (6 - pen.lineHeight(org)) / 2, org, 'right', w);
  y += 6 + 1.4;
  y +=
    typedCode(
      pen,
      s,
      x,
      y,
      { size: 2.54, font: 'mono', color: COLORS.ink, ls: 0.03, lh: 1.3 },
      {
        align: 'left',
        label: { ...LBL, size: 1.7639 },
      },
    ) + 1.4;
  const p: TextStyle = { size: 2.1167, font: 'regular', color: COLORS.text };
  const [, line] = PAPER_COPY.oneTicket(c.noun, c.once);
  for (const t of [line, PAPER_COPY.reprints[1], c.help.slice(0, 2).join(' · ')])
    if (t) y += pen.para(t, x, y, w, p, { maxLines: 2 }) + 1.4;
  const meta: TextStyle = { size: 1.905, font: 'regular', color: COLORS.muted };
  const top = H - 3.6 - (0.2 + 1 + pen.lineHeight(meta));
  pen.line(x, top + 0.1, x + w, top + 0.1, COLORS.hair, 0.2);
  pen.text(footMeta(c, s.issued), x, top + 1.2, meta);
  passbookLine(pen, s.mark, x + w, pen.baselineOf(meta, top + 1.2), 1.905);
  if (s.mode === 'test')
    watermark(
      pen,
      { w: W, h: H },
      { x: -1, y: -1, w: 0, h: 0 },
      { size: 6, tops: [0.18, 0.5, 0.82] },
    );
}

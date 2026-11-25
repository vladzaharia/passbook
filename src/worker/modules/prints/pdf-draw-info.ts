/** "Before you go" on the bottom half of an A4 or Letter sheet. */
import { FULL_PARTS } from '../../../passkit/template/paper-geometry.ts';
import { beforeTitle, infoColumns, rules } from '../../../web/paper/ticket-text.ts';
import { footRow, LBL } from './pdf-draw-parts.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';

const COL: TextStyle = { size: 3.175, font: 'regular', color: COLORS.text, lh: 1.4 };
const COL_B: TextStyle = { ...COL, font: 'semibold', color: COLORS.ink };
const RULE: TextStyle = { size: 2.9633, font: 'regular', color: COLORS.text, lh: 1.35 };
const RULE_B: TextStyle = { ...RULE, font: 'semibold', color: COLORS.ink };
const TERMS: TextStyle = { size: 2.54, font: 'regular', color: COLORS.muted, lh: 1.4 };
/** The footer row: its rule, then the meta line 2.25 mm under it. */
const FOOT_H = FULL_PARTS.foot;

export function drawInfo(pen: Pen, s: Sheet, info: Box): void {
  const c = s.content;
  const h2: TextStyle = { size: 4.2333, font: 'semibold', color: COLORS.ink };
  let y = info.y;
  pen.text(beforeTitle(c), info.x, y, h2);
  y += pen.lineHeight(h2) + 5;

  const cols = infoColumns(c);
  const cw = (info.w - 7 * (cols.length - 1)) / cols.length;
  let tallest = 0;
  for (const [i, col] of cols.entries()) {
    const x = info.x + i * (cw + 7);
    let cy = y;
    pen.text(col.title, x, cy, LBL);
    cy += pen.lineHeight(LBL) + 1.6;
    if (col.strong) cy += pen.para(col.strong, x, cy, cw, COL_B, { maxLines: 2 });
    for (const l of col.lines ?? []) cy += pen.para(l, x, cy, cw, COL, { maxLines: 3 });
    for (const li of col.list ?? []) {
      const lead = col.boxes ? 4.6 : 3.6;
      if (col.boxes)
        pen.strokeBox({ x: x + 0.15, y: cy + 1.05, w: 2.3, h: 2.3 }, COLORS.ink, 0.3, 0.5);
      else pen.fillBox({ x, y: cy + 1.55, w: 1.4, h: 1.4 }, COLORS.ink, 0.7);
      cy += pen.para(li, x + lead, cy, cw - lead, COL, { maxLines: 2 });
    }
    tallest = Math.max(tallest, cy - y);
  }
  y += tallest + 5;

  const wash = rules(c, s.design.fold);
  const rw = (info.w - 8 - 6 * (wash.length - 1)) / wash.length;
  const bodies = wash.map(([title, text]) => ({
    title,
    lines: pen.wrap(text, rw, RULE),
  }));
  const rh = Math.max(
    ...bodies.map((b) => pen.lineHeight(RULE_B) + b.lines.length * pen.lineHeight(RULE)),
  );
  pen.fillBox({ x: info.x, y, w: info.w, h: rh + 6.4 }, COLORS.wash, 2.5);
  for (const [i, b] of bodies.entries()) {
    const x = info.x + 4 + i * (rw + 6);
    pen.text(b.title, x, y + 3.2, RULE_B);
    for (const [j, l] of b.lines.entries())
      pen.text(l, x, y + 3.2 + pen.lineHeight(RULE_B) + j * pen.lineHeight(RULE), RULE);
  }
  y += rh + 6.4 + 5;

  if (c.terms) y += pen.labelled('Terms', LBL, c.terms, TERMS, info.x, y, info.w, 4) + 5;
  if (c.help.length) {
    const help: TextStyle = { size: 2.9633, font: 'regular', color: COLORS.text };
    const lh = pen.lineHeight(help);
    let x = info.x;
    pen.text('Help', x, y + (lh - pen.lineHeight(LBL)) / 2, LBL);
    x += pen.measure('Help', LBL) + 6;
    for (const h of c.help) {
      x += pen.text(h, x, y, help) + 6;
    }
  }
  const rule = info.y + info.h - FOOT_H;
  pen.line(info.x, rule + 0.125, info.x + info.w, rule + 0.125, COLORS.hair, 0.25);
  footRow(pen, s, info.x, info.w, rule + 2.25);
}

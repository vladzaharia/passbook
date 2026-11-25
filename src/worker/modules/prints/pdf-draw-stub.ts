/**
 * The one-row tickets: stub, boarding pass (ATB), A6 and DL. The text sits on the pass colour at the
 * left, the code on white at the right; the same boxes and words as the print page (ticket-strip.tsx).
 */
import { paperBoxes } from '../../../passkit/template/paper-geometry.ts';
import { passbookCredit } from '../../../shared/copy/passbook-credit.ts';
import { groupPrintCode } from '../../../shared/copy/print.ts';
import { codeLabel } from '../../../web/paper/ticket-parts.tsx';
import { stripText, stripType } from '../../../web/paper/ticket-strip-text.ts';
import { footMeta } from '../../../web/paper/ticket-text.ts';
import { codeMark, passbookLine, plate, specOf, typedCode } from './pdf-draw-parts.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';
import { watermark } from './pdf-test-mark.ts';

const BORDER = 0.3;

export function drawStrip(pen: Pen, s: Sheet): void {
  const c = s.content;
  const spec = specOf(s);
  const mono = c.ink === 'mono';
  const boxes = paperBoxes(s.design.size, c.kind, { barcode: s.drawing?.kind ?? 'qr' });
  const ticket = boxes.ticket as Box;
  const door = boxes.door as Box;
  const face = boxes.face as Box;
  const t = stripText(c, spec.heightMm, face.w);
  const ty = stripType(spec.heightMm);
  const fg = mono ? COLORS.ink : c.colors.fg;
  const label = mono ? COLORS.muted : c.colors.label;
  const panel: Box = {
    x: ticket.x + BORDER,
    y: ticket.y + BORDER,
    w: door.x - ticket.x - BORDER,
    h: ticket.h - 2 * BORDER,
  };
  if (!mono) pen.fillBox(panel, c.colors.bg, [3.7, 0, 0, 3.7]);
  pen.strokeBox(
    {
      x: ticket.x + BORDER / 2,
      y: ticket.y + BORDER / 2,
      w: ticket.w - BORDER,
      h: ticket.h - BORDER,
    },
    COLORS.rule,
    BORDER,
    3.85,
  );
  pen.line(door.x, ticket.y + 3, door.x, ticket.y + ticket.h - 3, COLORS.rule, 0.35, [0.9, 0.5]);

  const x = panel.x + ty.pad;
  const w = panel.w - 2 * ty.pad;
  let y = panel.y + ty.pad;
  const kick: TextStyle = { size: ty.kicker, font: 'medium', color: label, ls: 0.08, upper: true };
  const title: TextStyle = { size: ty.title, font: 'semibold', color: fg, lh: 1.1, ls: -0.01 };
  const when: TextStyle = { size: ty.when, font: 'medium', color: fg };
  const venue: TextStyle = { size: ty.venue, font: 'regular', color: fg };
  const meta: TextStyle = { size: ty.foot, font: 'regular', color: label };
  const metaBold: TextStyle = { ...meta, font: 'semibold' };

  if (t.compact) {
    pen.text(pen.wrap(`${t.brand} · ${t.kicker}`, w, kick, 1)[0] ?? '', x, y, kick);
    y += pen.lineHeight(kick) + 1;
  } else {
    const brand: TextStyle = { size: 2.8, font: 'semibold', color: fg };
    const lead = c.logo ? ty.plate + 2.4 : 0;
    const textH = pen.lineHeight(brand) + pen.lineHeight(kick);
    plate(pen, s, { x, y }, ty.plate, { color: '#000000', opacity: 0.18 });
    const top = y + (ty.plate - textH) / 2;
    pen.text(pen.wrap(t.brand, w - lead, brand, 1)[0] ?? '', x + lead, top, brand);
    pen.text(
      pen.wrap(t.kicker, w - lead, kick, 1)[0] ?? '',
      x + lead,
      top + pen.lineHeight(brand),
      kick,
    );
    y += Math.max(c.logo ? ty.plate : 0, textH) + 1.5 + 1;
  }
  const titleLines = pen.wrap(t.title, w, title, ty.titleLines);
  for (const l of titleLines) {
    pen.text(l, x, y, title);
    y += pen.lineHeight(title);
  }
  y += 1;
  if (t.when) y += pen.para(t.when, x, y, w, when, { maxLines: 2 }) + 1;
  if (t.venue) {
    pen.text(pen.wrap(t.venue, w, venue, 1)[0] ?? '', x, y, venue);
    y += pen.lineHeight(venue) + 1;
  }
  const rowsText = t.compact ? t.rows.map((r) => r.text).join(' · ') : '';
  if (rowsText) pen.text(pen.wrap(rowsText, w, venue, 1)[0] ?? '', x, y, venue);

  // Bottom: footer line, then the typed code (compact) or the facts boxes.
  const footTop = panel.y + panel.h - ty.pad - pen.lineHeight(meta);
  const credit = passbookCredit(s.mark);
  const pbW = credit
    ? pen.measure(credit.name ? `${credit.lead} ` : credit.lead, meta) +
      (credit.name ? pen.measure(credit.name, metaBold) : 0)
    : 0;
  pen.text(
    pen.wrap(footMeta(c, s.issued), w - pbW - (pbW ? 3 : 0), meta, 1)[0] ?? '',
    x,
    footTop,
    meta,
  );
  passbookLine(pen, s.mark, x + w, pen.baselineOf(meta, footTop), meta.size);

  if (t.compact) {
    const lineSt: TextStyle = { size: ty.typed, font: 'mono', color: fg, ls: 0.04, lh: 1.3 };
    const lbl: TextStyle = { size: 1.9, font: 'medium', color: label, ls: 0.08, upper: true };
    const typedTop = footTop - 1 - pen.lineHeight(lineSt);
    const text = codeLabel(c);
    const lw = pen.measure(text, lbl) + 2;
    pen.text(text, x, typedTop + (pen.lineHeight(lineSt) - pen.lineHeight(lbl)) / 2, lbl);
    pen.text(groupPrintCode(s.code), x + lw, typedTop, { ...lineSt, font: 'mono' });
  } else if (t.rows.length && t.stacked) {
    const lbl: TextStyle = {
      size: ty.rowLabel,
      font: 'medium',
      color: label,
      ls: 0.08,
      upper: true,
    };
    const val: TextStyle = { size: 3.4, font: 'semibold', color: fg, lh: 1.2 };
    const lineH = pen.lineHeight(val);
    const gap = 0.8;
    let top = footTop - 1.5 - (t.rows.length * lineH + (t.rows.length - 1) * gap);
    for (const r of t.rows) {
      pen.text(r.label, x, top + (lineH - pen.lineHeight(lbl)) / 2, lbl);
      pen.text(pen.wrap(r.text, w - 17, val, 1)[0] ?? '', x + 17, top, val);
      top += lineH + gap;
    }
  } else if (t.rows.length) {
    const lbl: TextStyle = {
      size: ty.rowLabel,
      font: 'medium',
      color: label,
      ls: 0.08,
      upper: true,
    };
    const val: TextStyle = { size: ty.rowValue, font: 'semibold', color: fg, lh: 1.2 };
    const h = 2.4 + pen.lineHeight(lbl) + pen.lineHeight(val);
    const top = footTop - 1.5 - h;
    const gap = 2;
    // Boxes size to their text and share the slack, like the page's flex row.
    const room = w - gap * (t.rows.length - 1);
    const natural = t.rows.map(
      (r) => Math.max(pen.measure(r.label, lbl), pen.measure(r.text, val)) + 4,
    );
    const sum = natural.reduce((n, v) => n + v, 0);
    const widths = natural.map((v) =>
      sum > room ? (v * room) / sum : v + (room - sum) / natural.length,
    );
    let bx = x;
    for (const [i, r] of t.rows.entries()) {
      const cw = widths[i] ?? 0;
      pen.strokeBox({ x: bx, y: top, w: cw, h }, fg, 0.25, 1.6);
      pen.text(r.label, bx + 2, top + 1.2, lbl);
      pen.text(
        pen.wrap(r.text, cw - 4, val, 1)[0] ?? '',
        bx + 2,
        top + 1.2 + pen.lineHeight(lbl),
        val,
      );
      bx += cw + gap;
    }
  }

  const code = codeMark(pen, s, boxes.code);
  if (boxes.typed)
    typedCode(
      pen,
      s,
      door.x + door.w / 2,
      code.y + code.h + 0.6,
      { size: 3.7042, font: 'mono', color: COLORS.ink, ls: 0.04, lh: 1.3 },
      { maxWidth: door.w - 4 },
    );
  if (s.mode === 'test') watermark(pen, { w: spec.widthMm, h: spec.heightMm }, door, { size: 6 });
}

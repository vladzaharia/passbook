/** The photo-led card in the PDF: badge, credential and ID. Same boxes as the page (badge-layout.ts). */
import { PAPER_COPY } from '../../../shared/copy/print.ts';
import { badgeFront, badgeLayout } from '../../../web/paper/badge-layout.ts';
import { footMeta } from '../../../web/paper/ticket-text.ts';
import {
  codeMark,
  LBL,
  META,
  passbookLine,
  photo,
  plate,
  specOf,
  typedCode,
} from './pdf-draw-parts.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';
import { watermark } from './pdf-test-mark.ts';

export function drawBadgeFront(pen: Pen, s: Sheet): void {
  const c = s.content;
  const spec = specOf(s);
  const mono = c.ink === 'mono';
  const L = badgeLayout(spec.widthMm, spec.heightMm);
  const f = badgeFront(c);
  const fg = mono ? COLORS.ink : c.colors.fg;
  if (!mono) pen.fillBox({ x: 0, y: 0, w: spec.widthMm, h: spec.heightMm }, c.colors.bg);
  plate(pen, s, L.plate, L.plate.w);
  const kicker: TextStyle = {
    size: 1.9,
    font: 'medium',
    color: mono ? COLORS.muted : c.colors.label,
    ls: 0.08,
    upper: true,
  };
  const head = pen.wrap(
    [c.kicker, c.brand].join(' · '),
    L.kicker.w,
    { ...kicker, upper: true },
    1,
  )[0];
  pen.text(head ?? '', L.kicker.x, L.kicker.y, kicker);
  photo(pen, s, L.photo, 2);
  const name: TextStyle = { size: L.name.size, font: 'semibold', color: fg, lh: 1.1 };
  pen.para(f.name, L.name.x, L.name.y, L.name.w, name, { maxLines: L.name.lines });
  if (f.role)
    pen.para(
      f.role,
      L.role.x,
      L.role.y,
      L.role.w,
      { size: 2.8, font: 'medium', color: fg },
      {
        maxLines: 1,
      },
    );
  const detail: TextStyle = { size: 2.3, font: 'regular', color: fg, lh: 1.35 };
  let y = L.details.y;
  for (const d of f.details.slice(0, L.details.lines)) {
    pen.para(d, L.details.x, y, L.details.w, detail, { maxLines: 1 });
    y += pen.lineHeight(detail);
  }
}

export function drawBadgeBack(pen: Pen, s: Sheet): void {
  const c = s.content;
  const spec = specOf(s);
  const L = badgeLayout(spec.widthMm, spec.heightMm);
  codeMark(pen, s, L.code as Box, spec, 1);
  const n = L.note;
  const centre = n.x + n.w / 2;
  let y = n.y;
  // A portrait card has the code above its note; a landscape one beside.
  y +=
    typedCode(
      pen,
      s,
      L.portrait ? centre : n.x,
      y,
      { size: 2.54, font: 'mono', color: COLORS.ink, ls: 0.03, lh: 1.3 },
      {
        maxWidth: n.w,
        ...(L.portrait ? {} : { align: 'left' as const }),
        label: { ...LBL, size: 1.7639 },
      },
    ) + 1.4;
  const [, line] = PAPER_COPY.oneTicket(c.noun, c.once);
  const p: TextStyle = { size: 2.1167, font: 'regular', color: COLORS.text, lh: 1.3 };
  for (const t of [line, c.help.slice(0, 2).join(' · ')])
    if (t) y += pen.para(t, n.x, y, n.w, p, { maxLines: 2 }) + 1.4;
  const top = n.y + n.h - (0.2 + 1 + (L.portrait ? 2 : 1) * pen.lineHeight(META));
  pen.line(n.x, top, n.x + n.w, top, COLORS.hair, 0.2);
  pen.text(pen.wrap(footMeta(c, s.issued), n.w, META, 1)[0] ?? '', n.x, top + 1.2, META);
  const second = top + 1.2 + (L.portrait ? pen.lineHeight(META) + 0.4 : 0);
  passbookLine(pen, s.mark, n.x + n.w, pen.baselineOf(META, second), 1.905);
  if (s.mode === 'test')
    watermark(
      pen,
      { w: spec.widthMm, h: spec.heightMm },
      { x: 0, y: 0, w: spec.widthMm, h: spec.heightMm },
    );
}

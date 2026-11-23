import { setGraphicsState } from 'pdf-lib';
import { PAPER_SPECS, type PaperSpec } from '../../../passkit/template/paper.ts';
import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import { passbookCredit } from '../../../shared/copy/passbook-credit.ts';
import { groupPrintCode, PRINT_COPY } from '../../../shared/copy/print.ts';
import { codeLabel } from '../../../web/paper/ticket-parts.tsx';
import { footMeta } from '../../../web/paper/ticket-text.ts';
import { drawCode } from './pdf-code.ts';
import { luminosityState } from './pdf-gstate.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';

/** The small uppercase label above a value (`.pp-lbl`). */
export const LBL: TextStyle = {
  size: 2.3283,
  font: 'medium',
  color: COLORS.muted,
  ls: 0.08,
  upper: true,
};
export const PASSBOOK: TextStyle = { size: 2.2578, font: 'regular', color: COLORS.muted, ls: 0.01 };
export const PASSBOOK_NAME: TextStyle = { ...PASSBOOK, font: 'semibold', color: COLORS.text };

export const ART_POS = {
  artwork: [0.5, 0.3],
  background: [0.5, 0.3],
  thumbnail: [1, 0.5],
  strip: [1, 0.5],
} as const;

export const specOf = (s: Sheet): PaperSpec => PAPER_SPECS[s.design.size];

/** The org's logo on a plate in the pass colour (black in mono); its initial when there is no image. */
export function plate(
  pen: Pen,
  s: Sheet,
  at: { x: number; y: number },
  size: number,
  tint?: { color: string; opacity: number },
): void {
  const c = s.content;
  if (!c.logo) return;
  const mono = c.ink === 'mono';
  const box: Box = { x: at.x, y: at.y, w: size, h: size };
  if (tint && !mono) pen.fillBox(box, tint.color, 2, tint.opacity);
  else pen.fillBox(box, mono ? '#000000' : c.colors.bg, 2);
  const logo = s.images.logo;
  if (logo) {
    const inner = size * 0.78;
    const b = { x: at.x + (size - inner) / 2, y: at.y + (size - inner) / 2, w: inner, h: inner };
    // Mono: the logo's lightness over the black plate, no colour.
    if (mono) pen.save(() => pen.contain(logo, b), setGraphicsState(luminosityState(pen.page)));
    else pen.contain(logo, b);
    return;
  }
  const st: TextStyle = {
    size: size * 0.43,
    font: 'bold',
    color: mono ? '#FFFFFF' : c.colors.fg,
    lh: 1,
  };
  pen.text(
    c.brand.slice(0, 1).toUpperCase(),
    at.x,
    at.y + (size - st.size) / 2,
    st,
    'center',
    size,
  );
}

/** The label and the print code in groups, centred under `cx`, from `top`. Returns the height. */
export function typedCode(
  pen: Pen,
  s: Sheet,
  cx: number,
  top: number,
  codeSt: TextStyle,
  options: { maxWidth?: number; align?: 'left' | 'center'; label?: TextStyle } = {},
): number {
  const label = codeLabel(s.content);
  const lbl = options.label ?? LBL;
  if (options.align === 'left') pen.text(label, cx, top, lbl);
  else pen.text(label, cx - 50, top, lbl, 'center', 100);
  let y = top + pen.lineHeight(lbl) + 0.8;
  const groups = groupPrintCode(s.code).split(' ');
  // Word spacing between groups: a mono space plus .35em.
  const gap = codeSt.size * (0.6 + (codeSt.ls ?? 0) + 0.35);
  const lines: string[][] = [];
  const max = options.maxWidth ?? Number.POSITIVE_INFINITY;
  let row: string[] = [];
  const widthOf = (g: string[]) =>
    g.reduce((n, t) => n + pen.measure(t, codeSt), 0) + gap * Math.max(0, g.length - 1);
  for (const g of groups) {
    if (row.length && widthOf([...row, g]) > max) {
      lines.push(row);
      row = [];
    }
    row.push(g);
  }
  lines.push(row);
  for (const r of lines) {
    let x = options.align === 'left' ? cx : cx - widthOf(r) / 2;
    for (const g of r) x += pen.text(g, x, y, codeSt) + gap;
    y += pen.lineHeight(codeSt);
  }
  return y - top;
}

/** The code, or the notice that it cannot be drawn. Returns the box it took. */
export function codeMark(
  pen: Pen,
  s: Sheet,
  centre: Box,
  spec: PaperSpec = specOf(s),
  radius = 0,
): Box {
  if (s.drawing) return drawCode(pen, s.drawing, spec, centre, radius);
  pen.text(
    PRINT_COPY.codeUnavailable,
    centre.x,
    centre.y + centre.h / 2 - 2,
    { size: 3.5, font: 'bold', color: COLORS.ink },
    'center',
    centre.w,
  );
  return centre;
}

/** The PassBook credit for `mark`, right-aligned to `right`, on the text baseline `baseline`; nothing at `none`. */
export function passbookLine(
  pen: Pen,
  mark: BrandMark,
  right: number,
  baseline: number,
  size = PASSBOOK.size,
): number {
  const credit = passbookCredit(mark);
  if (!credit) return 0;
  const plain = { ...PASSBOOK, size };
  const bold = { ...PASSBOOK_NAME, size };
  const lead = credit.name ? `${credit.lead} ` : credit.lead;
  const a = pen.measure(lead, plain);
  const b = credit.name ? pen.measure(credit.name, bold) : 0;
  const x = right - a - b;
  pen.text(lead, x, pen.topFor(plain, baseline), plain);
  if (credit.name) pen.text(credit.name, x + a, pen.topFor(bold, baseline), bold);
  return a + b;
}

export const META: TextStyle = { size: 2.3989, font: 'regular', color: COLORS.muted };

/** Footer row: the print number and issue time on the left, the PassBook credit on the right. */
export function footRow(
  pen: Pen,
  s: Sheet,
  x: number,
  w: number,
  top: number,
  extra = '',
  reserve = 0,
): void {
  const meta = [footMeta(s.content, s.issued), extra].filter(Boolean).join(' · ');
  const credit = passbookCredit(s.mark);
  const used = credit
    ? pen.measure([credit.lead, credit.name].filter(Boolean).join(' '), PASSBOOK) + 6
    : 0;
  pen.text(pen.wrap(meta, w - used - reserve, META, 1)[0] ?? '', x, top, META);
  passbookLine(pen, s.mark, x + w, pen.baselineOf(META, top));
}

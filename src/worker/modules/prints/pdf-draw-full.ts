/** A4, Letter and half sheet admission/membership/pickup: the drawn ticket, then "before you go". */
import type { PaperKind } from '../../../passkit/template/paper.ts';
import { HALF_FOOT, paperBoxes } from '../../../passkit/template/paper-geometry.ts';
import { PAPER_COPY } from '../../../shared/copy/print.ts';
import { buddyPose } from '../../../web/paper/ticket-buddy.tsx';
import { BAND, bandFit, bandTitleWidth } from '../../../web/paper/ticket-fit.ts';
import {
  compactBefore,
  doorRows,
  doorWhen,
  faceLines,
  faceNotesFit,
  folds,
} from '../../../web/paper/ticket-text.ts';
import { fitWidths } from '../../../web/paper/ticket-widths.ts';
import { drawBuddy } from './pdf-buddy.ts';
import { drawInfo } from './pdf-draw-info.ts';
import {
  ART_POS,
  codeMark,
  footRow,
  LBL,
  photo,
  plate,
  specOf,
  typedCode,
} from './pdf-draw-parts.ts';
import { fadeState } from './pdf-gstate.ts';
import { type Box, COLORS, type Pen, type TextStyle } from './pdf-kit.ts';
import type { Sheet } from './pdf-sheet.ts';
import { testStrip, watermark } from './pdf-test-mark.ts';

const NOTE: TextStyle = { size: 2.6, font: 'regular', color: COLORS.muted, lh: 1.35 };
const NOTE_B: TextStyle = { ...NOTE, font: 'semibold', color: COLORS.ink };

/** Rows under the door panel's code: label over value, flexed across the panel. */
function doorFacts(pen: Pen, s: Sheet, x: number, w: number, bottom: number): void {
  const rows = doorRows(s.content);
  if (!rows.length) return;
  const value: TextStyle = { size: 3.3514, font: 'semibold', color: COLORS.ink };
  const height = 0.25 + 2.4 + pen.lineHeight(LBL) + pen.lineHeight(value);
  const top = bottom - height;
  pen.line(x, top + 0.125, x + w, top + 0.125, COLORS.hair, 0.25);
  const gap = 4;
  const natural = rows.map((r) => Math.max(pen.measure(r.label, LBL), pen.measure(r.text, value)));
  // Boxes keep their text's width plus an equal share of the slack; only the widest give way.
  const widths = fitWidths(natural, w - gap * (rows.length - 1));
  let at = x;
  for (const [i, r] of rows.entries()) {
    const cw = widths[i] ?? 4;
    pen.text(pen.wrap(r.label, cw, LBL, 1)[0] ?? '', at, top + 2.65, LBL);
    pen.para(r.text, at, top + 2.65 + pen.lineHeight(LBL), cw, value, { maxLines: 1 });
    at += cw + gap;
  }
}

function band(pen: Pen, s: Sheet, face: Box, h: number): void {
  const c = s.content;
  const mono = c.ink === 'mono';
  const b: Box = { ...face, h };
  const radii: [number, number, number, number] = [0, 3.7, 0, 0];
  if (mono) {
    pen.line(b.x, b.y + h - 0.175, b.x + b.w, b.y + h - 0.175, COLORS.ink, 0.35);
  } else {
    pen.fillBox(b, c.colors.bg, radii);
    const art = s.images.art;
    if (art && c.art) {
      const [px, py] = ART_POS[c.art];
      pen.clipped(b, () => pen.cover(art, b, px, py), radii);
      const mask = fadeState(
        pen.page,
        { x0: pen.px(b.x + b.w * 0.38), x1: pen.px(b.x + b.w), a0: 1, a1: 0 },
        [pen.px(b.x), pen.py(b.y + b.h), pen.px(b.x + b.w), pen.py(b.y)],
      );
      pen.fillMasked(b, c.colors.bg, mask, radii);
    }
  }
  const fg = mono ? COLORS.ink : c.colors.fg;
  const x = b.x + BAND.padX;
  const top = b.y + BAND.padY;
  plate(pen, s, { x, y: top }, BAND.plate);
  const org: TextStyle = { size: 2.8222, font: 'semibold', color: fg, ls: 0.02 };
  pen.text(c.brand, x + (c.logo ? 11.4 : 0), top + (BAND.plate - pen.lineHeight(org)) / 2, org);
  if (c.photo)
    photo(
      pen,
      s,
      {
        x: b.x + b.w - BAND.padX - BAND.photo,
        y: b.y + h - BAND.padY - BAND.photo,
        w: BAND.photo,
        h: BAND.photo,
      },
      2,
    );
  const kicker: TextStyle = { ...LBL, color: mono ? COLORS.muted : c.colors.label };
  const width = bandTitleWidth(b.w, c.photo);
  const fit = bandFit(c.title, width, h);
  const title: TextStyle = { size: fit.size, font: 'semibold', color: fg, ls: -0.01, lh: BAND.lh };
  const lines = pen.wrap(c.title, width, title, fit.lines);
  const blockH = pen.lineHeight(kicker) + 1 + lines.length * pen.lineHeight(title);
  let y = b.y + h - BAND.padY - blockH;
  pen.text(c.kicker, x, y, kicker);
  y += pen.lineHeight(kicker) + 1;
  for (const l of lines) {
    pen.text(l, x, y, title);
    y += pen.lineHeight(title);
  }
}

const BIG: TextStyle = { size: 4.5861, font: 'semibold', color: COLORS.ink, lh: 1.2 };
const SUB: TextStyle = { size: 3.3514, font: 'regular', color: COLORS.text };

/** The holder panel under the band: when and where, the half sheet's notes, the seat boxes. */
function faceBody(pen: Pen, s: Sheet, face: Box, top: number, bottom: number, half: boolean): void {
  const c = s.content;
  const x = face.x + 6.5;
  const w = face.w - 13;
  const value: TextStyle = { size: 5.2917, font: 'semibold', color: COLORS.ink, lh: 1.1 };
  const factsH = c.facts.length ? 0.6 + 3.6 + pen.lineHeight(LBL) + 0.6 + pen.lineHeight(value) : 0;
  // Nothing runs into the fact boxes or the foot of the panel; a paragraph that does not fit is left out.
  const limit = bottom - 5.5 - (factsH ? factsH + 3.2 : 0);
  let y = top + 5;
  const put = (text: string, st: TextStyle) => {
    if (y + pen.paraHeight(text, w, st, 3) > limit) return;
    y += pen.para(text, x, y, w, st, { maxLines: 3 }) + 3.2;
  };
  const lines = faceLines(c, half);
  for (const l of lines) put(l.text, l.big ? BIG : SUB);
  if (half && faceNotesFit(lines)) {
    const before = compactBefore(c);
    const room = y + 2 * pen.lineHeight(NOTE) <= limit;
    if (before && room)
      y += pen.labelled(PAPER_COPY.before, NOTE_B, before, NOTE, x, y, w, 2) + 3.2;
    if (c.bring.length && y + 2 * pen.lineHeight(NOTE) <= limit)
      y += pen.labelled('Bring', NOTE_B, c.bring.join(' · '), NOTE, x, y, w, 2) + 3.2;
  }
  if (!c.facts.length) return;
  const h = factsH;
  const n = c.facts.length;
  const widths = fitWidths(
    c.facts.map((f) => Math.max(pen.measure(f.label, LBL), pen.measure(f.text, value)) + 5.4),
    w - 2 * (n - 1),
  );
  let bx = x;
  for (const [i, f] of c.facts.entries()) {
    const fw = widths[i] ?? 0;
    const box = { x: bx, y: bottom - 5.5 - h, w: fw, h };
    bx += fw + 2;
    pen.strokeBox(
      { x: box.x + 0.15, y: box.y + 0.15, w: box.w - 0.3, h: box.h - 0.3 },
      COLORS.hair,
      0.3,
      1.85,
    );
    pen.text(f.label, box.x + 2.7, box.y + 2.1, LBL);
    pen.para(f.text, box.x + 2.7, box.y + 2.1 + pen.lineHeight(LBL) + 0.6, fw - 5.4, value, {
      maxLines: 1,
    });
  }
}

/** The two notches: 7 mm half discs over the outline at the perforation. */
function notches(pen: Pen, t: Box, color: string): void {
  const cx = t.x + t.w / 2;
  pen.halfDisc(cx, t.y + 0.15, 3.35, 'below', COLORS.white, color, 0.3);
  pen.halfDisc(cx, t.y + t.h - 0.15, 3.35, 'above', COLORS.white, color, 0.3);
}

/** The drawn ticket's outline, perforation and notches. */
function outline(pen: Pen, s: Sheet, t: Box): void {
  const test = s.mode === 'test';
  const color = test ? COLORS.ink : COLORS.rule;
  pen.strokeBox(
    { x: t.x + 0.15, y: t.y + 0.15, w: t.w - 0.3, h: t.h - 0.3 },
    color,
    0.3,
    3.85,
    test ? [1.2, 0.9] : undefined,
  );
  const cx = t.x + t.w / 2;
  pen.line(cx, t.y + 4.3, cx, t.y + t.h - 4.3, COLORS.hair, 0.35, [1.1, 0.9]);
  notches(pen, t, color);
}

/** The fold ticks and their labels, at the page's half line and bottom centre. */
function foldMarks(pen: Pen, page: { w: number; h: number }, fold: { x: number; y: number }): void {
  const dash: [number, number] = [0.9, 0.5];
  const st: TextStyle = { size: 1.905, font: 'regular', color: COLORS.rule, ls: 0.08, upper: true };
  const label = PAPER_COPY.fold;
  pen.line(7, fold.y, 11, fold.y, COLORS.rule, 0.3, dash);
  pen.text(label, 12, fold.y - pen.lineHeight(st) / 2, st);
  pen.line(page.w - 11, fold.y, page.w - 7, fold.y, COLORS.rule, 0.3, dash);
  pen.text(label, page.w - 12 - pen.measure(label, st), fold.y - pen.lineHeight(st) / 2, st);
  pen.line(fold.x, page.h - 11, fold.x, page.h - 7, COLORS.rule, 0.3, dash);
}

/** The ticket on the top half (or the whole half sheet), then "Before you go" or the footer row. */
export function drawFull(pen: Pen, s: Sheet, half: boolean): void {
  const { content: c, design } = s;
  const spec = specOf(s);
  const page = { w: spec.widthMm, h: spec.heightMm };
  const mono = c.ink === 'mono';
  const test = s.mode === 'test';
  const pose = design.buddy ? buddyPose(c.kind, c.noun) : null;
  const boxes = paperBoxes(design.size, c.kind as PaperKind, {
    buddy: pose !== null,
    fold: design.fold && folds(c),
    mark: s.mark,
  });
  const t = boxes.ticket as Box;
  const doorW = (t.w - 0.6) / 2;
  const door: Box = { x: t.x + 0.3, y: t.y + 0.3, w: doorW, h: t.h - 0.6 };
  const face: Box = { ...door, x: door.x + doorW };
  const bandH = c.kind === 'pickup' ? 34 : half ? 38 : 44;

  // Holder panel first: the outline and notches go over its edges.
  band(pen, s, face, bandH);
  faceBody(pen, s, face, face.y + bandH, face.y + face.h, half);
  outline(pen, s, t);

  // Door panel.
  const x = door.x + 7;
  const w = door.w - 14;
  let y = door.y + 6;
  if (test) y += testStrip(pen, x, y - 1, w) + 1;
  const head: TextStyle = { size: 4.0569, font: 'semibold', color: COLORS.ink, lh: 1.15 };
  const org: TextStyle = { size: 2.4694, font: 'medium', color: COLORS.muted, ls: 0.02 };
  const lead = c.logo ? 14 : 0;
  const lines = pen.wrap(c.title, w - lead, head, 2);
  const textH = pen.lineHeight(org) + lines.length * pen.lineHeight(head);
  const headH = Math.max(c.logo ? 11 : 0, textH);
  plate(pen, s, { x, y: y + (headH - 11) / 2 }, 11);
  let ty = y + (headH - textH) / 2;
  pen.text(c.brand, x + lead, ty, org);
  ty += pen.lineHeight(org);
  for (const l of lines) {
    pen.text(l, x + lead, ty, head);
    ty += pen.lineHeight(head);
  }
  y += headH + 2.2;
  const when = doorWhen(c);
  if (when)
    pen.para(when, x, y, w, { size: 3.175, font: 'medium', color: COLORS.ink }, { maxLines: 2 });
  const code = codeMark(pen, s, boxes.code);
  const cx = door.x + door.w / 2;
  typedCode(pen, s, cx, code.y + code.h + 0.6, {
    size: 3.7042,
    font: 'mono',
    color: COLORS.ink,
    ls: 0.04,
    lh: 1.3,
  });
  doorFacts(pen, s, x, w, door.y + door.h - 5.5);

  // Below the ticket.
  if (half) {
    const row = { x: 12, y: page.h - 8 - HALF_FOOT, w: page.w - 24 };
    const base = row.y + HALF_FOOT / 2;
    const meta = pen.lineHeight({ size: 2.3989, font: 'regular', color: COLORS.muted });
    footRow(pen, s, row.x, row.w, base - meta / 2, c.help.join(' · '), boxes.buddy ? 16 : 0);
  } else if (boxes.info) drawInfo(pen, s, boxes.info);
  if (boxes.buddy && pose) drawBuddy(pen, boxes.buddy, pose, mono);
  if (boxes.fold) foldMarks(pen, page, boxes.fold);
  if (test) watermark(pen, page, { x: t.x, y: t.y, w: t.w / 2, h: t.h });
}

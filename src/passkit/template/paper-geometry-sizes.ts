/**
 * Layout boxes for the sizes that are not a page or a half sheet: the one-row strips (stub, ATB,
 * A6, DL), the cards and the home sheet that carries them, and the half-letter fit of the half-sheet
 * designs. Millimetres from the sheet's top-left corner; the page CSS and the PDF both read these.
 */
import { PAPER_SPECS, type PaperSheet, type PaperSize, type PaperSpec } from './paper.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaperBoxes {
  page: Box;
  /** The drawn ticket: outline, notches and perforation. Absent on the card and on permit/coupon. */
  ticket?: Box;
  /** Left half of the ticket: the code and the four facts staff check. On a strip, the code column. */
  door?: Box;
  /** Right half: band, logo, art, when and where. On a strip, the text panel. */
  face?: Box;
  /** The code with its quiet zone. */
  code: Box;
  /** A strip's typed-code line under the code; absent when the text panel carries it. */
  typed?: Box;
  /** The "Before you go" area (A4/Letter only). */
  info?: Box;
  /** The buddy cameo; absent when the class or size has none. */
  buddy?: Box;
  /** Vertical fold line x and horizontal fold line y (A4/Letter with `fold`). */
  fold?: { x: number; y: number };
}

/** The QR's quiet zone, in modules. */
export const QR_QUIET_MODULES = 4;

export const centred = (outer: Box, w: number, h: number, dy = 0): Box => ({
  x: outer.x + (outer.w - w) / 2,
  y: outer.y + (outer.h - h) / 2 + dy,
  w,
  h,
});

/** The symbol's width in mm; a size with no Code 128 width falls back to its QR width, never 0. */
export const codeSymbolMm = (spec: PaperSpec, kind: 'qr' | 'code128'): number =>
  kind === 'qr' ? spec.qrMm : spec.barMm || spec.qrMm;

/** Code box: the symbol plus its quiet zone, for the QR (square) or Code 128. */
export function codeSize(
  size: PaperSize,
  barcode: 'qr' | 'code128',
  modules = 25,
): { w: number; h: number } {
  const spec = PAPER_SPECS[size];
  if (barcode === 'qr') {
    const whole = (spec.qrMm * (modules + 2 * QR_QUIET_MODULES)) / modules;
    return { w: whole, h: whole };
  }
  // 332 modules plus a 10-module quiet zone each side. A size with no Code 128 width never draws at 0 mm.
  const bar = codeSymbolMm(spec, 'code128');
  return { w: (bar * (332 + 20)) / 332, h: Math.max(13, bar * 0.22) };
}

/** Strip margins: the stub and the ATB are die-cut stock, the rest keep the 8 mm printer margin. */
export const STRIP_INSET: Record<string, number> = { stub: 3.5, atb: 5, a6: 8, dl: 8 };
/** Padding inside the code column, and the height of the typed-code line under the code. */
export const STRIP_CODE_PAD = 4;
export const STRIP_TYPED_H = 9;
/** Text panel padding on a strip. */
export const STRIP_PAD = 4;
/** Strips shorter than this have no room for the brand row and the facts boxes. */
export const STRIP_COMPACT_H = 60;

export function stripBoxes(
  size: PaperSize,
  options: { barcode?: 'qr' | 'code128' } = {},
): PaperBoxes {
  const { widthMm: W, heightMm: H } = PAPER_SPECS[size];
  const inset = STRIP_INSET[size] ?? 8;
  const page: Box = { x: 0, y: 0, w: W, h: H };
  const ticket: Box = { x: inset, y: inset, w: W - 2 * inset, h: H - 2 * inset };
  const code = codeSize(size, options.barcode ?? 'qr');
  const beside = ticket.h < code.h + STRIP_TYPED_H + 4;
  const colW = Math.max(code.w, beside ? 0 : 44) + 2 * STRIP_CODE_PAD;
  const door: Box = { ...ticket, x: ticket.x + ticket.w - colW, w: colW };
  const face: Box = { ...ticket, w: ticket.w - colW };
  const stack = beside ? code.h : code.h + STRIP_TYPED_H;
  const top = door.y + (door.h - stack) / 2;
  const codeBox: Box = { x: door.x + (door.w - code.w) / 2, y: top, ...code };
  const out: PaperBoxes = { page, ticket, door, face, code: codeBox };
  if (!beside) out.typed = { x: door.x, y: top + code.h, w: door.w, h: STRIP_TYPED_H };
  return out;
}

/** A card's code: right of the text on a landscape card, under it on a portrait one. */
export function cardBoxes(size: PaperSize): PaperBoxes {
  const { widthMm: W, heightMm: H } = PAPER_SPECS[size];
  const page: Box = { x: 0, y: 0, w: W, h: H };
  const code = codeSize(size, 'qr');
  if (H > W) return { page, code: { x: (W - code.w) / 2, y: H - 4 - code.h, ...code } };
  return { page, code: { x: W - 3.4 - code.w, y: (H - code.h) / 2, ...code } };
}

export const SHEET_TOP = 20;
/** The full-colour face runs this far past its cut line, so a cut that wanders still leaves colour. */
export const BLEED = 1.5;
const MARK_GAP = 1.5;
const MARK_LEN = 4;
/** The fold line runs this far past the card at both ends. */
const FOLD_EXTRA = 4;

type Segment = [number, number, number, number];

export interface SheetFace {
  /** The face's cut line on the sheet. */
  box: Box;
  /** Turned half a turn: a landscape card folds on a horizontal edge, so its back must read upside down. A portrait card folds on a vertical edge, like a page turning, and stays upright. */
  rotated: boolean;
  /** Bleed past the cut line, per side. Only a full-colour face has any. */
  bleed: { top: number; right: number; bottom: number; left: number };
}

export interface SheetLayout {
  page: Box;
  /** A card: front, then back; a strip: its one face. */
  faces: SheetFace[];
  /** Cut marks as line segments: a tick at each outer corner, outside the cut line and its bleed. */
  cuts: Segment[];
  /** A card's dashed fold line, on the edge the faces share. */
  fold?: Segment;
}

const NO_BLEED = { top: 0, right: 0, bottom: 0, left: 0 };

const inside = (page: Box, [x1, y1, x2, y2]: Segment): boolean =>
  [x1, x2].every((x) => x >= 0 && x <= page.w) && [y1, y2].every((y) => y >= 0 && y <= page.h);

/** Ticks at the corners of `r`, `gap` clear of it; those that would fall off the sheet are dropped. */
function corners(page: Box, r: Box, gap: number): Segment[] {
  const out: Segment[] = [];
  for (const cx of [r.x, r.x + r.w])
    for (const cy of [r.y, r.y + r.h]) {
      const sx = cx === r.x ? -1 : 1;
      const sy = cy === r.y ? -1 : 1;
      out.push([cx + sx * gap, cy, cx + sx * (gap + MARK_LEN), cy]);
      out.push([cx, cy + sy * gap, cx, cy + sy * (gap + MARK_LEN)]);
    }
  return out.filter((seg) => inside(page, seg));
}

/**
 * A holder's print on an A4 or Letter sheet at true size, with cut marks. A strip is one face at
 * the top centre. A card is a fold: the faces meet on the long edge (stacked for a landscape card,
 * side by side for a portrait one), a landscape card's back turned half a turn (a portrait card's stays upright, as it turns on a vertical edge),
 * with a dashed fold line and a bleed on the full-colour front.
 */
export function sheetLayout(size: PaperSize, sheet: PaperSheet): SheetLayout {
  const { widthMm: pw, heightMm: ph } = PAPER_SPECS[sheet];
  const { widthMm: cw, heightMm: ch, layout } = PAPER_SPECS[size];
  const page: Box = { x: 0, y: 0, w: pw, h: ph };
  if (layout === 'strip') {
    const box: Box = { x: (pw - cw) / 2, y: SHEET_TOP, w: cw, h: ch };
    return {
      page,
      faces: [{ box, rotated: false, bleed: NO_BLEED }],
      cuts: corners(page, box, MARK_GAP),
    };
  }
  const stacked = cw > ch;
  const w = stacked ? cw : 2 * cw;
  const h = stacked ? 2 * ch : ch;
  const x = (pw - w) / 2;
  const front: Box = { x, y: SHEET_TOP, w: cw, h: ch };
  const back: Box = stacked ? { ...front, y: front.y + ch } : { ...front, x: front.x + cw };
  const bleed = stacked
    ? { top: BLEED, right: BLEED, bottom: 0, left: BLEED }
    : { top: BLEED, right: 0, bottom: BLEED, left: BLEED };
  const fold: Segment = stacked
    ? [x - FOLD_EXTRA, front.y + ch, x + cw + FOLD_EXTRA, front.y + ch]
    : [front.x + cw, SHEET_TOP - FOLD_EXTRA, front.x + cw, SHEET_TOP + ch + FOLD_EXTRA];
  return {
    page,
    faces: [
      { box: front, rotated: false, bleed },
      { box: back, rotated: stacked, bleed: NO_BLEED },
    ],
    cuts: corners(page, { x, y: SHEET_TOP, w, h }, MARK_GAP + BLEED),
    fold,
  };
}

/** The 210 x 148 permit and coupon designs. */
export const HALF_DESIGN = { w: 210, h: 148 } as const;

/** How a half-sheet design fits a half-sized page that is not 210 x 148: scale to the height, centre across. */
export function halfFit(size: PaperSize): { scale: number; dx: number } {
  const { widthMm: W, heightMm: H } = PAPER_SPECS[size];
  const scale = Math.min(W / HALF_DESIGN.w, H / HALF_DESIGN.h);
  return { scale, dx: (W - HALF_DESIGN.w * scale) / 2 };
}

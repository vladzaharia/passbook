/**
 * Layout boxes for the sizes that are not a page or a half sheet: the one-row strips (stub, ATB,
 * A6, DL), the cards and the home sheet that carries them, and the half-letter fit of the half-sheet
 * designs. Millimetres from the sheet's top-left corner; the page CSS and the PDF both read these.
 */
import { PAPER_SPECS, type PaperSheet, type PaperSize } from './paper.ts';

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
  // 332 modules plus a 10-module quiet zone each side.
  return { w: (spec.barMm * (332 + 20)) / 332, h: Math.max(13, spec.barMm * 0.22) };
}

/** Strip margins: the stub is die-cut stock, the rest keep the 8 mm printer margin. */
export const STRIP_INSET: Record<string, number> = { stub: 3.5, atb: 8, a6: 8, dl: 8 };
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
export const SHEET_GAP = 12;
const MARK_GAP = 1.5;
const MARK_LEN = 4;

export interface SheetLayout {
  page: Box;
  /** Front, then back. */
  cards: [Box, Box];
  /** Cut marks as line segments [x1, y1, x2, y2]: a tick at each corner, outside the card. */
  cuts: [number, number, number, number][];
}

/** Both faces of a card side by side near the top of an A4 or Letter sheet, centred, with corner cut marks. */
export function sheetLayout(size: PaperSize, sheet: PaperSheet): SheetLayout {
  const { widthMm: pw, heightMm: ph } = PAPER_SPECS[sheet];
  const { widthMm: cw, heightMm: ch } = PAPER_SPECS[size];
  const left = (pw - (2 * cw + SHEET_GAP)) / 2;
  const front: Box = { x: left, y: SHEET_TOP, w: cw, h: ch };
  const back: Box = { ...front, x: left + cw + SHEET_GAP };
  const cuts: SheetLayout['cuts'] = [];
  for (const b of [front, back])
    for (const cx of [b.x, b.x + b.w])
      for (const cy of [b.y, b.y + b.h]) {
        const sx = cx === b.x ? -1 : 1;
        const sy = cy === b.y ? -1 : 1;
        cuts.push([cx + sx * MARK_GAP, cy, cx + sx * (MARK_GAP + MARK_LEN), cy]);
        cuts.push([cx, cy + sy * MARK_GAP, cx, cy + sy * (MARK_GAP + MARK_LEN)]);
      }
  return { page: { x: 0, y: 0, w: pw, h: ph }, cards: [front, back], cuts };
}

/** The 210 x 148 permit and coupon designs. */
export const HALF_DESIGN = { w: 210, h: 148 } as const;

/** How a half-sheet design fits a half-sized page that is not 210 x 148: scale to the height, centre across. */
export function halfFit(size: PaperSize): { scale: number; dx: number } {
  const { widthMm: W, heightMm: H } = PAPER_SPECS[size];
  const scale = Math.min(W / HALF_DESIGN.w, H / HALF_DESIGN.h);
  return { scale, dx: (W - HALF_DESIGN.w * scale) / 2 };
}

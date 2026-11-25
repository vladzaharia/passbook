/**
 * The layout boxes of a printed ticket, in mm from the sheet's top-left corner. The page CSS is
 * ported from these numbers and the PDF draws from them, so the two cannot drift. Boxes of flexed
 * content (the code inside its panel) are the design position within a few mm.
 */
import { BUDDY_MM, BUDDY_RATIO } from '../../shared/paper-buddy.ts';
import { PAPER_SPECS, type PaperKind, type PaperSize } from './paper.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Nothing meaningful sits closer to an edge: home printers clip 3 to 6.5 mm. */
export const PAPER_INSET = 8;
/** The QR's quiet zone, in modules. */
export const QR_QUIET_MODULES = 4;
/** The 7 mm notches at the stub, the 4 mm fold ticks, and the code's distance from either fold. */
export const TICKET_SHAPE = {
  notch: 7,
  radius: 4,
  foldTick: 4,
  foldInset: 7,
  minFoldGap: 14,
} as const;
/** Heights fixed by the layout: the footer row and the colour band on the holder panel. */
export const FULL_PARTS = {
  foot: 6,
  band: 44,
  bandLow: 34,
  infoInset: 12,
  infoTop: 9,
  buddyInset: 6,
} as const;
export const HALF_FOOT = 12;
/** The coupon's colour band; the offer and the code sit under it. */
export const COUPON_BAND = 50;

export interface PaperBoxes {
  page: Box;
  /** The drawn ticket: outline, notches and perforation. Absent on the card and on permit/coupon. */
  ticket?: Box;
  /** Left half of the ticket: the code and the four facts staff check. */
  door?: Box;
  /** Right half: band, logo, art, when and where. */
  face?: Box;
  /** The code with its quiet zone. */
  code: Box;
  /** The "Before you go" area (A4/Letter only). */
  info?: Box;
  /** The buddy cameo; absent when the class or size has none. */
  buddy?: Box;
  /** Vertical fold line x and horizontal fold line y (A4/Letter with `fold`). */
  fold?: { x: number; y: number };
}

const centred = (outer: Box, w: number, h: number, dy = 0): Box => ({
  x: outer.x + (outer.w - w) / 2,
  y: outer.y + (outer.h - h) / 2 + dy,
  w,
  h,
});

/** Code box: the symbol plus its quiet zone, for the QR (square) or Code 128 (`barHeight` mm). */
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
  return { w: (spec.barMm * (332 + 20)) / 332, h: 15 };
}

/** The boxes for one size and class. `buddy` adds the cameo box where the class has one. */
export function paperBoxes(
  size: PaperSize,
  kind: PaperKind,
  options: {
    barcode?: 'qr' | 'code128';
    buddy?: boolean;
    fold?: boolean;
    /** The org's footer choice: at `none` the half sheet's cameo takes the right edge. */
    mark?: 'full' | 'small' | 'none';
  } = {},
): PaperBoxes {
  const { widthMm: W, heightMm: H } = PAPER_SPECS[size];
  const page: Box = { x: 0, y: 0, w: W, h: H };
  const buddyH = BUDDY_MM.default * BUDDY_RATIO;
  const buddyBox = (right: number, ruleY: number): Box => ({
    x: right - BUDDY_MM.default,
    y: ruleY - buddyH + 1.1,
    w: BUDDY_MM.default,
    h: buddyH,
  });
  if (size === 'cr80') {
    const code = codeSize(size, 'qr');
    return { page, code: { x: W - 3.4 - code.w, y: (H - code.h) / 2, ...code } };
  }
  if (size === 'half' && (kind === 'permit' || kind === 'coupon')) {
    const barcode = options.barcode ?? (kind === 'coupon' ? 'code128' : 'qr');
    const code = codeSize(size, barcode);
    const side: Box =
      kind === 'permit'
        ? { x: W - PAPER_INSET - 54, y: 31, w: 54, h: 84 }
        : { x: W - 10.5 - 97, y: 10.5 + COUPON_BAND + 4, w: 97, h: H - 21 - COUPON_BAND - 4 - 14 };
    const out: PaperBoxes = { page, code: centred(side, code.w, code.h) };
    if (options.buddy && kind === 'coupon') out.buddy = buddyBox(W - 10.5 - 4, H - 10.5 - 11);
    return out;
  }
  const half = size === 'half';
  const ticketH = half ? H - 2 * PAPER_INSET - HALF_FOOT : H / 2 - 2 * PAPER_INSET;
  const ticket: Box = { x: PAPER_INSET, y: PAPER_INSET, w: W - 2 * PAPER_INSET, h: ticketH };
  const door: Box = { ...ticket, w: ticket.w / 2 };
  const face: Box = { ...ticket, x: ticket.x + ticket.w / 2, w: ticket.w / 2 };
  const code = codeSize(size, 'qr');
  // Between the head (about 24 mm) and the facts row (about 16 mm), centred.
  const slot: Box = { x: door.x, y: door.y + 24, w: door.w, h: door.h - 24 - 16 };
  const out: PaperBoxes = { page, ticket, door, face, code: centred(slot, code.w, code.h) };
  if (half) {
    // In the footer row under the ticket, left of the PassBook credit (about 26 mm), or at the edge without one.
    const credit = options.mark === 'none' ? 0 : 26 + 3;
    if (options.buddy)
      out.buddy = {
        x: W - FULL_PARTS.infoInset - credit - BUDDY_MM.default,
        y: H - PAPER_INSET - HALF_FOOT + (HALF_FOOT - buddyH) / 2,
        w: BUDDY_MM.default,
        h: buddyH,
      };
    return out;
  }
  const inset = FULL_PARTS.infoInset;
  out.info = {
    x: inset,
    y: H / 2 + FULL_PARTS.infoTop,
    w: W - 2 * inset,
    h: H / 2 - FULL_PARTS.infoTop - inset,
  };
  if (options.fold !== false) out.fold = { x: W / 2, y: H / 2 };
  if (options.buddy)
    out.buddy = buddyBox(W - inset - FULL_PARTS.buddyInset, H - inset - FULL_PARTS.foot);
  return out;
}

export const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

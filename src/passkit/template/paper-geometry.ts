/**
 * The layout boxes of a printed ticket, in mm from the sheet's top-left corner. The page CSS is
 * ported from these numbers and the PDF draws from them, so the two cannot drift. Boxes of flexed
 * content (the code inside its panel) are the design position within a few mm.
 */
import { BUDDY_MM, BUDDY_RATIO } from '../../shared/paper-buddy.ts';
import { PAPER_SPECS, type PaperKind, type PaperSize } from './paper.ts';
import {
  type Box,
  cardBoxes,
  centred,
  codeSize,
  type PaperBoxes,
  stripBoxes,
} from './paper-geometry-sizes.ts';

export {
  type Box,
  codeSize,
  HALF_DESIGN,
  halfFit,
  type PaperBoxes,
  QR_QUIET_MODULES,
  type SheetLayout,
  sheetLayout,
} from './paper-geometry-sizes.ts';

/** Nothing meaningful sits closer to an edge: home printers clip 3 to 6.5 mm. */
export const PAPER_INSET = 8;
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
  const layout = PAPER_SPECS[size].layout;
  if (layout === 'card') return cardBoxes(size);
  if (layout === 'strip')
    return stripBoxes(size, options.barcode ? { barcode: options.barcode } : {});
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
  const half = layout === 'half';
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

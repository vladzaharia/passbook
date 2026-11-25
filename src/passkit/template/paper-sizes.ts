/** The physical sizes a ticket prints at: spec table, Code 128 rule and the home sheets for cards. */

export const PAPER_SIZES = [
  'a4',
  'letter',
  'half',
  'cr80',
  'cr80p',
  'stub',
  'atb',
  'a6',
  'dl',
  'half-letter',
] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** How a size lays the ticket out: full page with "before you go", half sheet, one-row strip, card with two faces. */
export type PaperLayout = 'page' | 'half' | 'strip' | 'card';

export interface PaperSpec {
  label: string;
  layout: PaperLayout;
  widthMm: number;
  heightMm: number;
  /** The QR symbol's side, without its quiet zone. At least 30 mm everywhere. */
  qrMm: number;
  /** Code 128 width in mm, with 0.2 mm or wider bars. */
  barMm: number;
}

/** Code 128 needs 0.25 mm modules (2 dots at 203 dpi thermal): 332 modules, 83 mm. */
export const CODE128_MIN_MM = 83;

/**
 * Page sizes in mm. `half` is a half sheet, landscape; `cr80` and `cr80p` are ISO/IEC 7810 ID-1
 * cards. `stub` is 2 x 5.5 in ticket stock (QR beside the text, a stacked 30 mm QR does not fit).
 * `atb` is the IATA ATB boarding-pass document, exactly 7.375 x 3.25 in (187.325 x 82.55 mm,
 * Resolution 722e section 6.6.1). It stays 7.375 in, not the 8 in thermal stock: on 8 in stock a
 * shorter page just advances to the next gap, a longer one would spill onto the next ticket. `dl` is
 * the one-third-A4 insert (99 x 210 mm). `barMm` is 0 where Code 128 does not fit at `CODE128_MIN_MM`.
 */
export const PAPER_SPECS: Record<PaperSize, PaperSpec> = {
  a4: { label: 'A4', layout: 'page', widthMm: 210, heightMm: 297, qrMm: 45, barMm: 100 },
  letter: {
    label: 'Letter',
    layout: 'page',
    widthMm: 215.9,
    heightMm: 279.4,
    qrMm: 45,
    barMm: 100,
  },
  half: { label: 'Half sheet', layout: 'half', widthMm: 210, heightMm: 148, qrMm: 38, barMm: 90 },
  cr80: {
    label: 'Card, landscape',
    layout: 'card',
    widthMm: 85.6,
    heightMm: 54,
    qrMm: 30,
    barMm: 0,
  },
  cr80p: {
    label: 'Card, portrait',
    layout: 'card',
    widthMm: 54,
    heightMm: 85.6,
    qrMm: 30,
    barMm: 0,
  },
  stub: {
    label: 'Ticket stub',
    layout: 'strip',
    widthMm: 139.7,
    heightMm: 50.8,
    qrMm: 30,
    barMm: 0,
  },
  atb: {
    label: 'Boarding pass',
    layout: 'strip',
    widthMm: 187.325,
    heightMm: 82.55,
    qrMm: 32,
    barMm: 83,
  },
  a6: { label: 'A6 postcard', layout: 'strip', widthMm: 148, heightMm: 105, qrMm: 34, barMm: 0 },
  dl: { label: 'DL insert', layout: 'strip', widthMm: 210, heightMm: 99, qrMm: 36, barMm: 88 },
  'half-letter': {
    label: 'Half letter',
    layout: 'half',
    widthMm: 215.9,
    heightMm: 139.7,
    qrMm: 38,
    barMm: 90,
  },
};

/** Code 128 fits this size. */
export const supportsCode128 = (size: PaperSize): boolean =>
  PAPER_SPECS[size].barMm >= CODE128_MIN_MM;

/** Cards and strips can print on a home sheet, with cut marks. */
export const PAPER_SHEETS = ['a4', 'letter'] as const;
export type PaperSheet = (typeof PAPER_SHEETS)[number];

/** Card and strip sizes take a home sheet; pages and half sheets already print on one. */
export const sheetApplies = (size: PaperSize): boolean =>
  PAPER_SPECS[size].layout === 'card' || PAPER_SPECS[size].layout === 'strip';

/** The sheet a design prints on: its home sheet when it has one, else its own size. */
export const pageSizeOf = (design: {
  size: PaperSize;
  sheet?: PaperSheet | undefined;
}): PaperSize => (design.sheet && sheetApplies(design.size) ? design.sheet : design.size);

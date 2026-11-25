/**
 * How a title fits the holder panel's band, shared by the page and the PDF so both break and clamp
 * alike. Sizes are mm. The band's top row (logo and brand) and its bottom block (class word and
 * title) never touch: the title takes the largest size whose lines fit between them.
 */
export const BAND = {
  padX: 6.5,
  padY: 5.5,
  plate: 9,
  gap: 2,
  /** The class word and the space under it. */
  kicker: 4,
  size: 6.7028,
  lh: 1.08,
  /** The holder's photo on a badge: a square at the band's right. */
  photo: 28,
} as const;

/** Rubik semibold averages a little over half an em per character. */
const EM = 0.58;
const SIZES = [BAND.size, 5.8, 5.0, 4.4];

/** The ticket's face is half of the drawn ticket, which is the page less its 8 mm inset. */
export const faceWidth = (pageW: number): number => (pageW - 16 - 0.6) / 2;

/** The width the title may run: 80 % of the band's text width, or what the photo leaves. */
export const bandTitleWidth = (faceW: number, photo: boolean): number =>
  photo ? faceW - 2 * BAND.padX - BAND.photo - 3 : (faceW - 2 * BAND.padX) * 0.8;

export interface TitleFit {
  size: number;
  lines: number;
}

export function bandFit(title: string, widthMm: number, bandH: number): TitleFit {
  const room = bandH - 2 * BAND.padY - BAND.plate - BAND.gap - BAND.kicker;
  let last: TitleFit = { size: SIZES.at(-1) ?? BAND.size, lines: 1 };
  for (const size of SIZES) {
    const lh = size * BAND.lh;
    const fits = Math.max(1, Math.floor(room / lh));
    const need = Math.max(1, Math.ceil((title.length * size * EM) / widthMm));
    last = { size, lines: Math.min(fits, need) };
    if (need <= fits) return last;
  }
  return last;
}

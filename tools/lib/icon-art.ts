// The PassBook app icon as standalone SVG: the mark (src/web/ui/layout/brand-mark.tsx) on the dark
// tile, in the dark palette's teal and foil. tools/build-icons.ts renders these into public/.

export const ICON_COLORS = {
  /** The tile: the dark theme's raised surface, the card the buddy sits on. */
  tile: '#0d111b',
  /** The dark page: manifest colours and the social image. */
  page: '#060912',
  line: '#2dd4bf',
  foil: ['#2dd4bf', '#9a5cff', '#ffc24d'],
} as const;

const [F1, F2, F3] = ICON_COLORS.foil;
const L = ICON_COLORS.line;

const svg = (box: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${body}</svg>`;

/** BrandMark's shapes on its 20-unit grid, dark palette filled in. */
const MARK_20 = `<clipPath id="p"><rect y="-3" width="20" height="10"/></clipPath><g clip-path="url(#p)"><rect fill="${F1}" x="3" y="1" width="6" height="9" rx="1.25" transform="rotate(-18 6 10)"/><rect fill="${F3}" x="11" y="1" width="6" height="9" rx="1.25" transform="rotate(18 14 10)"/><rect fill="${F2}" x="7" width="6" height="9" rx="1.25"/></g><rect x="1" y="7" width="18" height="12" rx="3.5" fill="none" stroke="${L}" stroke-width="2"/><circle fill="${L}" cx="7" cy="12.5" r="1.5"/><circle fill="${L}" cx="13" cy="12.5" r="1.5"/><path d="M8 15.25q2 1.5 4 0" fill="none" stroke="${L}" stroke-width="1.5" stroke-linecap="round"/>`;

/**
 * The mark redrawn on a 32-unit grid for tabs: pocket edges and eyes on even units, so it is sharp
 * at 32 px and at 16 px on 1× screens (1 px lines, 2 px eyes). Round eyes and passes at ±18°, as
 * in the 20-unit mark; the passes stand taller over a shorter pocket, so the foil reads in a tab.
 */
const MARK_32 = `<clipPath id="p"><rect width="32" height="13"/></clipPath><g clip-path="url(#p)"><rect fill="${F1}" x="5" y="4" width="8" height="12" rx="1.5" transform="rotate(-18 9 16)"/><rect fill="${F3}" x="19" y="4" width="8" height="12" rx="1.5" transform="rotate(18 23 16)"/><rect fill="${F2}" x="12" y="2" width="8" height="12" rx="1.5"/></g><rect x="5" y="13" width="22" height="14" rx="4" fill="none" stroke="${L}" stroke-width="2"/><circle fill="${L}" cx="12" cy="18" r="2"/><circle fill="${L}" cx="20" cy="18" r="2"/><path d="M13.5 22.5q2.5 2 5 0" fill="none" stroke="${L}" stroke-width="2" stroke-linecap="round"/>`;

/** The 16 px frame, pixel by pixel: 2 px eyes and a four-pixel smile a scaled curve cannot draw. */
const MARK_16 = `<clipPath id="p"><rect width="16" height="6.5"/></clipPath><g clip-path="url(#p)"><rect fill="${F1}" x="2.5" y="2" width="4" height="6" rx=".75" transform="rotate(-18 4.5 8)"/><rect fill="${F3}" x="9.5" y="2" width="4" height="6" rx=".75" transform="rotate(18 11.5 8)"/><rect fill="${F2}" x="6" y="1" width="4" height="6" rx=".75"/></g><rect x="2.5" y="6.5" width="11" height="8" rx="2" fill="none" stroke="${L}"/><path fill="${L}" d="M5 8h2v2H5zM9 8h2v2H9zM6 11h1v1H6zM9 11h1v1H9zM7 12h2v1H7z"/>`;

/** favicon.svg and the 32 and 48 px ICO frames. */
export const tabIconSvg = () =>
  svg(32, `<rect width="32" height="32" rx="7" fill="${ICON_COLORS.tile}"/>${MARK_32}`);

/** The 16 px ICO frame. */
export const tinyIconSvg = () =>
  svg(16, `<rect width="16" height="16" rx="3.5" fill="${ICON_COLORS.tile}"/>${MARK_16}`);

/**
 * The app icon on a 100-unit box. round: a rounded tile with clear corners (PWA "any"); square:
 * full bleed for platforms that mask it (iOS, maskable). `scale` is the mark's share of the box.
 */
export function appIconSvg({ shape, scale }: { shape: 'round' | 'square'; scale: number }): string {
  const size = 100 * scale;
  const at = (100 - size) / 2;
  const rx = shape === 'round' ? ' rx="22"' : '';
  return svg(
    100,
    `<rect width="100" height="100"${rx} fill="${ICON_COLORS.tile}"/><g transform="translate(${at} ${at}) scale(${size / 20})">${MARK_20}</g>`,
  );
}

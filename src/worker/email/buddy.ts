import { escapeHtml } from '../../shared/html.ts';

/** The moods the emails use: happy for a link sent, curious for "is this you?". */
export const EMAIL_MOODS = ['happy', 'curious'] as const;
export type EmailMood = (typeof EMAIL_MOODS)[number];

/** One palette per scheme; dark clients that honour <picture> media swap to the dark art. */
export const EMAIL_SCHEMES = ['light', 'dark'] as const;
export type EmailScheme = (typeof EMAIL_SCHEMES)[number];

export const BUDDY_SLICES = ['top', 'legs'] as const;
export type BuddySlice = (typeof BUDDY_SLICES)[number];

/**
 * The seated mascot over the email card, from tools/build-email-art.ts: the wallet art at the
 * canonical L size (128×96) in each scheme's tokens, cut at the seam (its base, y 66 of 72). Mail
 * clients cannot overlap two table cells, so the art is two images: the top stands in the band
 * above the card, the legs and contact shadow sit in the card's first row, over the foil. The feet
 * reach past the art's box (it draws with overflow visible), so the legs slice runs 12 px down.
 */
export const EMAIL_BUDDY = { width: 128, height: 96, seam: 88, legs: 12 } as const;

export const sliceHeight = (slice: BuddySlice) =>
  slice === 'top' ? EMAIL_BUDDY.seam : EMAIL_BUDDY.legs;

export const buddyPath = (
  mood: EmailMood,
  scheme: EmailScheme,
  slice: BuddySlice,
  density: 2 | 3,
) => `/email/buddy-${mood}-${scheme}-${slice}-${density}x.png`;

/** Static assets answer a literal `@` with a 307 to `%40`; mail clients get the final URL. */
export const emailAssetUrl = (base: string, path: string) =>
  `${base}${path.replaceAll('@', '%40')}`;

/** One slice. Decorative: empty alt, presentation role, fixed box so blocked images keep the layout. */
export function buddySliceHtml(base: string, mood: EmailMood, slice: BuddySlice): string {
  const width = EMAIL_BUDDY.width;
  const height = sliceHeight(slice);
  const set = (scheme: EmailScheme) =>
    escapeHtml(
      `${base}${buddyPath(mood, scheme, slice, 2)} 2x, ${base}${buddyPath(mood, scheme, slice, 3)} 3x`,
    );
  const src = escapeHtml(`${base}${buddyPath(mood, 'light', slice, 2)}`);
  return `<picture><source srcset="${set('dark')}" media="(prefers-color-scheme: dark)"><img src="${src}" srcset="${set('light')}" alt="" role="presentation" width="${width}" height="${height}" border="0" style="display:block;width:${width}px;height:${height}px;border:0;outline:none;text-decoration:none"></picture>`;
}

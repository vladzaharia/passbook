import {
  type BuddySlice,
  type BuddyTier,
  buddyPath,
  EMAIL_BUDDY,
  type EmailMood,
  type EmailScheme,
  sliceHeight,
} from '../../shared/email-art.ts';
import { escapeHtml } from '../../shared/html.ts';

/** Static assets answer a literal `@` with a 307 to `%40`; mail clients get the final URL. */
export const emailAssetUrl = (base: string, path: string) =>
  `${base}${path.replaceAll('@', '%40')}`;

/** One slice. Decorative: empty alt, presentation role, fixed box so blocked images keep the layout. */
export function buddySliceHtml(
  base: string,
  tier: BuddyTier,
  mood: EmailMood,
  slice: BuddySlice,
): string {
  const width = EMAIL_BUDDY[tier].width;
  const height = sliceHeight(tier, slice);
  const path = (scheme: EmailScheme, density: 2 | 3) =>
    `${base}${buddyPath(tier, mood, scheme, slice, density)}`;
  const set = (scheme: EmailScheme) => escapeHtml(`${path(scheme, 2)} 2x, ${path(scheme, 3)} 3x`);
  // Outlook (Word) shows only the <img>; <picture> and srcset are for the clients that read them.
  return `<picture><source srcset="${set('dark')}" media="(prefers-color-scheme: dark)"><img src="${escapeHtml(path('light', 2))}" srcset="${set('light')}" alt="" role="presentation" width="${width}" height="${height}" border="0" style="display:block;width:${width}px;height:${height}px;border:0;outline:none;text-decoration:none"></picture>`;
}

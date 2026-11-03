import {
  type BuddySlice,
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

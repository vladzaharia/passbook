import { escapeHtml } from '../../shared/html.ts';

/** The moods the emails use: happy for a link sent, curious for "is this you?". */
export const EMAIL_MOODS = ['happy', 'curious'] as const;
export type EmailMood = (typeof EMAIL_MOODS)[number];

/**
 * The mascot for the email header, from tools/build-email-art.ts: the wallet art (96×72 view box)
 * in its dark palette at 1.25×. The crop (whole CSS pixels) runs from above the fan into the
 * pocket's bottom stroke, so it stands on the header's bottom edge, and ends 4 px right of it.
 * Transparent: the filled pocket carries its own contrast on light, grey and black.
 */
export const EMAIL_BUDDY = {
  scale: 1.25,
  crop: { x: 7.2, y: 5.6, width: 76.8, height: 60.8 },
  width: 96,
  height: 76,
} as const;

export const buddyPath = (mood: EmailMood, density: 2 | 3) =>
  `/email/buddy-${mood}@${density}x.png`;

/** Decorative: empty alt, presentation role, fixed box so blocked images keep the layout. */
export function buddyImg(base: string, mood: EmailMood): string {
  const { width, height } = EMAIL_BUDDY;
  const src = escapeHtml(`${base}${buddyPath(mood, 2)}`);
  const hi = escapeHtml(`${base}${buddyPath(mood, 3)}`);
  return `<img src="${src}" srcset="${src} 2x, ${hi} 3x" alt="" role="presentation" width="${width}" height="${height}" border="0" style="display:block;width:${width}px;height:${height}px;border:0;outline:none;text-decoration:none">`;
}

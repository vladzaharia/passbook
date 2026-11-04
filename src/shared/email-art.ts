/**
 * The emails' art: the seated buddy (tools/build-email-art.ts writes it to public/email), shared by
 * the email renderer and the console's preview of the pass email, and the Apple badge's box.
 */

/** The moods the emails use: happy for a link sent, curious for "is this you?". */
export const EMAIL_MOODS = ['happy', 'curious'] as const;
export type EmailMood = (typeof EMAIL_MOODS)[number];

/** One palette per scheme; dark clients that honour <picture> media swap to the dark art. */
export const EMAIL_SCHEMES = ['light', 'dark'] as const;
export type EmailScheme = (typeof EMAIL_SCHEMES)[number];

export const BUDDY_SLICES = ['top', 'legs'] as const;
export type BuddySlice = (typeof BUDDY_SLICES)[number];

/** The pass is ready: happy, when the org opts in (`email.buddy`). */
export const PASS_EMAIL_MOOD: EmailMood = 'happy';

/**
 * The seated mascot over the email card, from tools/build-email-art.ts: the wallet art at the
 * canonical L size (128×96) in each scheme's tokens, cut at the seam (its base, y 66 of 72). Mail
 * clients cannot overlap two table cells, so the art is two images: the top stands in the band
 * above the card, the legs and contact shadow sit in the card's first row, over the foil. The feet
 * reach past the art's box (it draws with overflow visible), so the legs slice runs 12 px down.
 */
export const EMAIL_BUDDY = { width: 128, height: 96, seam: 88, legs: 12 } as const;

/**
 * Apple's black badge for email (480×148 px) at 44 px tall, the touch height. Unmodified art: its
 * grey edge carries it on dark cards, so it needs no ground of its own.
 */
export const EMAIL_BADGE = {
  path: '/apple/badge/en/black@2x.png',
  width: 143,
  height: 44,
} as const;

export const sliceHeight = (slice: BuddySlice) =>
  slice === 'top' ? EMAIL_BUDDY.seam : EMAIL_BUDDY.legs;

export const buddyPath = (
  mood: EmailMood,
  scheme: EmailScheme,
  slice: BuddySlice,
  density: 2 | 3,
) => `/email/buddy-${mood}-${scheme}-${slice}-${density}x.png`;

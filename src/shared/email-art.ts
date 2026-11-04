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
 * The seated mascot over the email card, from tools/build-email-art.ts: the wallet art in each
 * scheme's tokens, cut at the seam (its base, y 66 of 72). Mail clients cannot overlap two table
 * cells, so the art is two images: the top stands in the band above the card, the legs and contact
 * shadow sit in the card's first row, over the foil. The feet reach past the art's box (it draws
 * with overflow visible), so the legs slice runs below it.
 *
 * Two tiers (motion-and-expression.md, The buddy): L in the sign-in email, PassBook's own band; M
 * in the pass email, where the org's mark and name lead and need the room at 390 px. `face`: the
 * face's centre above the card, where the band's name lines up. `clear`: the transparent columns
 * right of the pocket's ink. `moods`: the ones its email uses.
 */
export const EMAIL_BUDDY = {
  l: { width: 128, height: 96, seam: 88, legs: 12, face: 28, clear: 20, moods: EMAIL_MOODS },
  m: { width: 96, height: 72, seam: 66, legs: 9, face: 21, clear: 15, moods: [PASS_EMAIL_MOOD] },
} as const;
export type BuddyTier = keyof typeof EMAIL_BUDDY;
export const BUDDY_TIERS = Object.keys(EMAIL_BUDDY) as BuddyTier[];

/**
 * Apple's black badge for email (480×148 px) at 44 px tall, the touch height. Unmodified art: its
 * grey edge carries it on dark cards, so it needs no ground of its own.
 */
export const EMAIL_BADGE = {
  path: '/apple/badge/en/black@2x.png',
  width: 143,
  height: 44,
} as const;

export const sliceHeight = (tier: BuddyTier, slice: BuddySlice) =>
  slice === 'top' ? EMAIL_BUDDY[tier].seam : EMAIL_BUDDY[tier].legs;

/** L keeps its first file names: pass emails already sent link them. */
export const buddyPath = (
  tier: BuddyTier,
  mood: EmailMood,
  scheme: EmailScheme,
  slice: BuddySlice,
  density: 2 | 3,
) => `/email/buddy-${tier === 'l' ? '' : `${tier}-`}${mood}-${scheme}-${slice}-${density}x.png`;

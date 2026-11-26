/** Where an invitation link opens, for every kind; the secret rides in the fragment. */
export const INVITE_PATH = '/invite';

/** A non-secret prefix routes a secret to its table: member, developer or platform. An unprefixed 43-character secret is a member invitation sent before the prefixes. */
export const INVITE_PREFIX = { member: 'm_', developer: 'd_', platform: 'p_' } as const;
export type InviteKind = keyof typeof INVITE_PREFIX;

/** The shape of any invitation secret: an optional kind prefix and 43 URL-safe characters. */
export const INVITE_SECRET = /^(?:[mdp]_)?[A-Za-z0-9_-]{43}$/;

const PREFIXED_LENGTH = 45;

/** Which kind a secret names, or null for a string that is no invitation secret. */
export function inviteKindOf(secret: string): InviteKind | null {
  if (!INVITE_SECRET.test(secret)) return null;
  // A prefixed secret is 45 characters; a 43-character one has none, whatever its first letters are.
  if (secret.length === PREFIXED_LENGTH) {
    if (secret.startsWith(INVITE_PREFIX.developer)) return 'developer';
    if (secret.startsWith(INVITE_PREFIX.platform)) return 'platform';
  }
  return 'member';
}

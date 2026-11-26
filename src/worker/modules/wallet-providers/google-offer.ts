import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { GoogleValidatedAccount } from './google-credentials.ts';
import { googleIssuedAt, signGoogleJwt } from './google-crypto.ts';
import { GoogleWalletError } from './google-errors.ts';
import { type DerivedGoogleId, type GoogleObjectScope, googleObjectIds } from './google-ids.ts';
import { GOOGLE_RESOURCES } from './google-rest.ts';

export interface GoogleSaveOfferOptions {
  origins: readonly string[];
  issuedAt: number;
  lifetimeSeconds?: number;
  /** The object's type; Generic when absent. */
  type?: GoogleType;
}

export interface GoogleSaveOffer {
  url: string;
  expiresAt: number;
  /** The one object the link references, so a bundle can sign several into one link. */
  objectId: DerivedGoogleId;
  type: GoogleType;
}

function googleOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins)) throw new GoogleWalletError('invalid_input', 'origins');
  return origins.map((origin) => {
    try {
      if (typeof origin !== 'string') throw new Error();
      const url = new URL(origin);
      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error();
      }
      return url.origin;
    } catch {
      throw new GoogleWalletError('invalid_input', 'origins');
    }
  });
}

// Existing-object links: https://developers.google.com/wallet/generic/use-cases/save-multiple-pass-types
// The caller must provision the object and enforce current authorization before issuing an offer.
export async function createGoogleSaveOffer(
  account: GoogleValidatedAccount,
  idSecret: Uint8Array,
  scope: GoogleObjectScope,
  options: GoogleSaveOfferOptions,
): Promise<GoogleSaveOffer> {
  if (!options) throw new GoogleWalletError('invalid_input', 'offer');
  const issuedAt = googleIssuedAt(options.issuedAt);
  const lifetime = options.lifetimeSeconds ?? 900;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > 900) {
    throw new GoogleWalletError('invalid_input', 'offer');
  }
  const origins = googleOrigins(options.origins);
  const { objectId } = await googleObjectIds(account.issuerId, idSecret, scope);
  // The payload key is the object collection's name, pluralised (genericObjects, loyaltyObjects, ...).
  const type = options.type ?? 'generic';
  const payload = { [`${GOOGLE_RESOURCES[type].object}s`]: [{ id: objectId }] };
  // Google does not document exp enforcement; callers must expire their own offer endpoint.
  const expiresAt = issuedAt + lifetime;
  const jwt = await signGoogleJwt(account, {
    iss: account.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: issuedAt,
    exp: expiresAt,
    origins,
    payload,
  });
  return { url: `https://pay.google.com/gp/v/save/${jwt}`, expiresAt, objectId, type };
}

/** Google refuses a save link longer than this many characters. */
export const GOOGLE_SAVE_LINK_MAX = 1800;
const SAVE_PREFIX = 'https://pay.google.com/gp/v/save/';

/**
 * One save link carrying several objects this server just issued links for. It is built from the object ids
 * issuance returned, never from a URL: only a known object type becomes a payload key, and every id must
 * belong to this issuer. It expires with the earliest member. Past Google's length limit it throws, and the
 * caller sends fewer objects.
 */
export async function combineGoogleSaveRefs(
  account: GoogleValidatedAccount,
  refs: readonly { objectId: string; type: GoogleType; expiresAt: number }[],
  options: { origins: readonly string[]; issuedAt: number },
): Promise<GoogleSaveOffer['url']> {
  if (refs.length === 0) throw new GoogleWalletError('invalid_input', 'offer');
  const payload: Record<string, { id: string }[]> = {};
  for (const ref of refs) {
    const resource = GOOGLE_RESOURCES[ref.type]?.object;
    if (!resource || !ref.objectId.startsWith(`${account.issuerId}.`))
      throw new GoogleWalletError('invalid_input', 'offer');
    const key = `${resource}s`;
    payload[key] = [...(payload[key] ?? []), { id: ref.objectId }];
  }
  const jwt = await signGoogleJwt(account, {
    iss: account.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: googleIssuedAt(options.issuedAt),
    exp: Math.min(...refs.map((ref) => ref.expiresAt)),
    origins: googleOrigins(options.origins),
    payload,
  });
  const url = `${SAVE_PREFIX}${jwt}`;
  if (url.length > GOOGLE_SAVE_LINK_MAX) throw new GoogleWalletError('invalid_input', 'offer');
  return url;
}

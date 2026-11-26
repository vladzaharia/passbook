import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { GoogleValidatedAccount } from './google-credentials.ts';
import { googleIssuedAt, signGoogleJwt } from './google-crypto.ts';
import { GoogleWalletError } from './google-errors.ts';
import { type GoogleObjectScope, googleObjectIds } from './google-ids.ts';
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
  const payload = {
    [`${GOOGLE_RESOURCES[options.type ?? 'generic'].object}s`]: [{ id: objectId }],
  };
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
  return { url: `https://pay.google.com/gp/v/save/${jwt}`, expiresAt };
}

/** Google refuses a save link longer than this many characters. */
export const GOOGLE_SAVE_LINK_MAX = 1800;
const SAVE_PREFIX = 'https://pay.google.com/gp/v/save/';

function savePayload(url: string): {
  exp: number;
  origins: string[];
  payload: Record<string, unknown[]>;
} {
  try {
    const part = url.slice(SAVE_PREFIX.length).split('.')[1] ?? '';
    const bytes = Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const { exp, origins, payload } = claims;
    if (!url.startsWith(SAVE_PREFIX) || typeof exp !== 'number' || !Array.isArray(origins))
      throw new Error();
    if (typeof payload !== 'object' || payload === null) throw new Error();
    return { exp, origins: origins as string[], payload: payload as Record<string, unknown[]> };
  } catch {
    throw new GoogleWalletError('invalid_input', 'offer');
  }
}

/**
 * One save link that carries every object of the single-object links this server just signed (one tap adds
 * them all). It expires with the earliest of them and is refused past Google's length limit; the caller
 * splits a bundle into several links before that.
 */
export async function combineGoogleSaveOffers(
  account: GoogleValidatedAccount,
  urls: readonly string[],
  issuedAt: number,
): Promise<GoogleSaveOffer> {
  const parts = urls.map(savePayload);
  const first = parts[0];
  if (!first) throw new GoogleWalletError('invalid_input', 'offer');
  const origins = [...first.origins].sort().join();
  const payload: Record<string, unknown[]> = {};
  for (const part of parts) {
    if ([...part.origins].sort().join() !== origins)
      throw new GoogleWalletError('invalid_input', 'offer');
    for (const [key, objects] of Object.entries(part.payload))
      payload[key] = [...(payload[key] ?? []), ...(Array.isArray(objects) ? objects : [])];
  }
  const expiresAt = Math.min(...parts.map((part) => part.exp));
  const jwt = await signGoogleJwt(account, {
    iss: account.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: googleIssuedAt(issuedAt),
    exp: expiresAt,
    origins: first.origins,
    payload,
  });
  const url = `${SAVE_PREFIX}${jwt}`;
  if (url.length > GOOGLE_SAVE_LINK_MAX) throw new GoogleWalletError('invalid_input', 'offer');
  return { url, expiresAt };
}

import type { GoogleValidatedAccount } from './google-credentials.ts';
import { googleIssuedAt, signGoogleJwt } from './google-crypto.ts';
import { GoogleWalletError } from './google-errors.ts';
import { type GoogleObjectScope, googleObjectIds } from './google-ids.ts';

export interface GoogleSaveOfferOptions {
  origins: readonly string[];
  issuedAt: number;
  lifetimeSeconds?: number;
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
  const payload = { genericObjects: [{ id: objectId }] };
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

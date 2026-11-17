import {
  credentialAad,
  decryptSecretText,
  derivedHmacKey,
  encryptSecret,
  loadKekRing,
} from './crypto.ts';
import { NotFoundError, UnavailableError } from './errors.ts';
import { toHex } from './ids.ts';
import { createLogger } from './log.ts';
import { readSeal, SEALS, type SealRow, type TokenPurpose } from './repo-capability-token.ts';

export { sealPart, sealStatement } from './repo-capability-token.ts';
export type { SealRow, TokenPurpose };

/**
 * Capability tokens (pass download links, bundle links) at rest. The token column stores a lookup MAC
 * (`h1:` + HMAC-SHA-256 under a derived key), never the token. The link is shown again from a sealed
 * copy (AES-GCM envelope, AAD = id|org|purpose). Rows not yet backfilled still hold the plain token:
 * a lookup tries the MAC and the plain value (`tokenKeys`), and `revealToken` returns it as is.
 */
export const MAC_PREFIX = 'h1:';
const encoder = new TextEncoder();
const log = createLogger({ module: 'capability-token' });

export const isTokenMac = (stored: string): boolean => stored.startsWith(MAC_PREFIX);

export async function tokenMac(env: object, purpose: TokenPurpose, token: string): Promise<string> {
  const key = await derivedHmacKey(env, 'capability-token.v1');
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${purpose}|${token}`) as BufferSource,
  );
  return MAC_PREFIX + toHex(new Uint8Array(mac));
}

/**
 * The two column values a presented token can match: its MAC and the plain value of a row not yet
 * backfilled. A presented value shaped like a MAC never matches itself, so a leaked MAC is no link.
 */
export async function tokenKeys(
  env: object,
  purpose: TokenPurpose,
  token: string,
): Promise<[string, string]> {
  const mac = await tokenMac(env, purpose, token);
  return [mac, isTokenMac(token) ? mac : token];
}

/** A new token as it is stored: the MAC for the token column and the sealed copy. */
export interface IssuedToken {
  token: string;
  mac: string;
  seal: SealRow;
}

export async function sealToken(
  env: object,
  purpose: TokenPurpose,
  id: string,
  orgId: string,
  token: string,
): Promise<SealRow> {
  const aad = credentialAad(id, orgId, SEALS[purpose].kind);
  return encryptSecret(await loadKekRing(env), token, aad);
}

export async function issueToken(
  env: object,
  purpose: TokenPurpose,
  id: string,
  orgId: string,
  token: string,
): Promise<IssuedToken> {
  const [mac, seal] = await Promise.all([
    tokenMac(env, purpose, token),
    sealToken(env, purpose, id, orgId, token),
  ]);
  return { token, mac, seal };
}

const bytes = (v: number[] | ArrayBuffer) => new Uint8Array(v);

/** The plain token of a stored column value: a row not yet backfilled holds it, others are unsealed. */
export async function revealToken(
  env: { DB: D1Database },
  purpose: TokenPurpose,
  id: string,
  orgId: string,
  stored: string,
): Promise<string> {
  if (!isTokenMac(stored)) return stored;
  const row = await readSeal(env.DB, purpose, id, orgId);
  if (!row) {
    log.error('token.seal_missing', { code: 'TOKEN_SEAL_MISSING', purpose, id });
    throw new UnavailableError('The link is unavailable. Rotate it.', 'TOKEN_SEAL_MISSING');
  }
  let plain: string;
  try {
    plain = await decryptSecretText(
      await loadKekRing(env),
      {
        kekVersion: row.kek_version,
        iv: bytes(row.iv),
        wrappedDek: bytes(row.wrapped_dek),
        ciphertext: bytes(row.ciphertext),
      },
      credentialAad(id, orgId, SEALS[purpose].kind),
    );
  } catch {
    log.error('token.seal_unreadable', { code: 'TOKEN_SEAL_UNREADABLE', purpose, id });
    throw new UnavailableError('The link is unavailable. Rotate it.', 'TOKEN_SEAL_UNREADABLE');
  }
  // A copy that is not of the token this row holds (a write that skipped the seal) must not be shown.
  if ((await tokenMac(env, purpose, plain)) !== stored) {
    log.error('token.seal_mismatch', { code: 'TOKEN_SEAL_MISMATCH', purpose, id });
    // The row moved to another token since the caller read it: the caller's snapshot is stale.
    throw new NotFoundError('This link is not valid.', 'TOKEN_SEAL_MISMATCH');
  }
  return plain;
}

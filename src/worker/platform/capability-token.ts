import {
  credentialAad,
  decryptSecretText,
  derivedHmacKey,
  encryptSecret,
  loadKekRing,
  macPreviousVersion,
} from './crypto.ts';
import { NotFoundError, UnavailableError } from './errors.ts';
import { safeEqual, toHex } from './ids.ts';
import { createLogger } from './log.ts';
import {
  readSeal,
  SEALS,
  type SealRaw,
  type SealRow,
  type TokenPurpose,
} from './repo-capability-token.ts';

export { sealPart, sealStatement } from './repo-capability-token.ts';
export type { SealRaw, SealRow, TokenPurpose };
/** The purposes the MAC-root sweep (cron tokens.remac) moves. Join link tokens are not swept yet. */
export type RemacPurpose = Exclude<TokenPurpose, 'join'>;

/**
 * Capability tokens (pass download links, bundle links, the Apple web-service token) at rest. The token
 * column stores a lookup MAC (`h1:` + HMAC-SHA-256 under a derived key), never the token: a plain value is
 * refused by the database. The token is shown or built again from a sealed copy (AES-GCM envelope,
 * AAD = id|org|purpose); a token just made, not yet stored, is used as it is (`revealToken`).
 */
export const MAC_PREFIX = 'h1:';
const encoder = new TextEncoder();
const log = createLogger({ module: 'capability-token' });

export const isTokenMac = (stored: string): boolean => stored.startsWith(MAC_PREFIX);

/** Each secret kind has its own derived key: a MAC of one kind never verifies as another's. */
const MAC_KEYS: Record<TokenPurpose, string> = {
  pass: 'capability-token.v1',
  bundle: 'capability-token.v1',
  'apple-auth': 'apple-auth-token.v1',
  join: 'join-link-token.v1',
};

export async function tokenMac(
  env: object,
  purpose: TokenPurpose,
  token: string,
  version?: number,
): Promise<string> {
  const key = await derivedHmacKey(env, MAC_KEYS[purpose], version);
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${purpose}|${token}`) as BufferSource,
  );
  return MAC_PREFIX + toHex(new Uint8Array(mac));
}

/** Every MAC a stored column may hold for `token`: the current root's, then (mid-rotation) the previous one's. */
export async function tokenMacs(
  env: object,
  purpose: TokenPurpose,
  token: string,
): Promise<[string, ...string[]]> {
  const previous = macPreviousVersion(env);
  const mac = await tokenMac(env, purpose, token);
  return previous === null ? [mac] : [mac, await tokenMac(env, purpose, token, previous)];
}

/**
 * The column values a presented token can match: its MAC, and its MAC under the previous root (the MAC
 * again when no rotation is running). A presented value shaped like a MAC never matches itself, so a
 * leaked MAC is no link.
 */
export async function tokenKeys(
  env: object,
  purpose: TokenPurpose,
  token: string,
): Promise<[string, string]> {
  const [mac, previous = mac] = await tokenMacs(env, purpose, token);
  return [mac, previous];
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

/**
 * Whether `presented` is the token a column holds, in constant time: the column holds the MAC of the
 * presented value, so a MAC read from the database is no token.
 */
export async function tokenMatches(
  env: object,
  purpose: TokenPurpose,
  stored: string,
  presented: string,
): Promise<boolean> {
  // The MAC is computed for every row, so a known and an unknown row cost the same.
  const macs = await tokenMacs(env, purpose, presented);
  const matches = await Promise.all(macs.map((mac) => safeEqual(mac, stored)));
  return matches.includes(true);
}

const bytes = (v: number[] | ArrayBuffer) => new Uint8Array(v);

function notSealed(purpose: TokenPurpose, id: string): UnavailableError {
  log.error('token.not_sealed', { code: 'TOKEN_NOT_SEALED', purpose, id });
  return new UnavailableError('The link is unavailable. Rotate it.', 'TOKEN_NOT_SEALED');
}

/** The plain token of a stored column value, unsealed. A value that is not a MAC is never stored (0070): it is refused. */
export async function revealToken(
  env: { DB: D1Database },
  purpose: TokenPurpose,
  id: string,
  orgId: string,
  stored: string,
): Promise<string> {
  if (!isTokenMac(stored)) throw notSealed(purpose, id);
  return unsealToken(env, purpose, id, orgId, stored, await readSeal(env.DB, purpose, id, orgId));
}

/** `revealToken` for a caller that read the sealed copy itself (in a batch of its own reads). */
export async function unsealToken(
  env: object,
  purpose: TokenPurpose,
  id: string,
  orgId: string,
  stored: string,
  row: SealRaw | null,
): Promise<string> {
  if (!isTokenMac(stored)) throw notSealed(purpose, id);
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
  if (!(await tokenMacs(env, purpose, plain)).includes(stored)) {
    log.error('token.seal_mismatch', { code: 'TOKEN_SEAL_MISMATCH', purpose, id });
    // The row moved to another token since the caller read it: the caller's snapshot is stale.
    throw new NotFoundError('This link is not valid.', 'TOKEN_SEAL_MISMATCH');
  }
  return plain;
}

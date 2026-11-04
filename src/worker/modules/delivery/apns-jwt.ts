import { toBase64Url } from '../../platform/ids.ts';
import type { PushKey } from '../identities/push-key-store.ts';

/** Apple wants a fresh token at least every 60 minutes and rejects more than one per 20. */
export const JWT_REFRESH_MS = 40 * 60_000;

const encoder = new TextEncoder();
const cache = new Map<string, { token: string; issuedAt: number }>();

const part = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));

export function clearApnsTokens(): void {
  cache.clear();
}

export function dropTeamApnsTokens(team: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${team}:`)) cache.delete(k);
}

export function dropApnsToken(team: string, keyId: string): void {
  cache.delete(`${team}:${keyId}`);
}

/**
 * ES256 provider token. WebCrypto returns IEEE P1363 (r||s), the format JWS wants, so the
 * signature needs no DER conversion. Cached per isolate by team and key ID.
 */
export async function apnsToken(team: string, key: PushKey, now: number): Promise<string> {
  const cacheKey = `${team}:${key.keyId}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.issuedAt >= 0 && now - hit.issuedAt < JWT_REFRESH_MS) return hit.token;
  const signingInput = `${part({ alg: 'ES256', kid: key.keyId })}.${part({ iss: team, iat: Math.floor(now / 1000) })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key.key,
      encoder.encode(signingInput),
    ),
  );
  const token = `${signingInput}.${toBase64Url(signature)}`;
  cache.set(cacheKey, { token, issuedAt: now });
  return token;
}

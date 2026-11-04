import { describe, expect, it } from 'vitest';
import { fromBase64Url } from '../../platform/ids.ts';
import { makeP8 } from '../identities/push-key-fixtures.ts';
import { apnsToken, clearApnsTokens, dropApnsToken, JWT_REFRESH_MS } from './apns-jwt.ts';

const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));

async function keyOf(kid = 'ABC123DEFG') {
  const p = await makeP8();
  return { p, key: { keyId: kid, key: p.privateKey } };
}

describe('apns provider token', () => {
  it('is an ES256 JWT with kid, iss and iat, signed r||s', async () => {
    clearApnsTokens();
    const { p, key } = await keyOf();
    const now = 1_700_000_123_456;
    const jwt = await apnsToken('TEAM123456', key, now);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(decode(claims)).toEqual({ iss: 'TEAM123456', iat: 1_700_000_123 });
    const raw = fromBase64Url(signature);
    expect(raw.length).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      p.publicKey,
      raw as BufferSource,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(ok).toBe(true);
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it('is cached per team and key ID, and refreshed between 20 and 50 minutes', async () => {
    clearApnsTokens();
    const { key } = await keyOf();
    expect(JWT_REFRESH_MS).toBeGreaterThanOrEqual(20 * 60_000);
    expect(JWT_REFRESH_MS).toBeLessThanOrEqual(50 * 60_000);
    const t0 = 1_700_000_000_000;
    const first = await apnsToken('TEAM123456', key, t0);
    expect(await apnsToken('TEAM123456', key, t0 + 19 * 60_000)).toBe(first);
    const other = await apnsToken('OTHERTEAM1', key, t0);
    expect(other).not.toBe(first);
    const renewed = await apnsToken('TEAM123456', key, t0 + JWT_REFRESH_MS);
    expect(renewed).not.toBe(first);
    expect(decode(renewed.split('.')[1] ?? '').iat).toBe(Math.floor((t0 + JWT_REFRESH_MS) / 1000));
  });

  it('signs again after the token is dropped', async () => {
    clearApnsTokens();
    const { key } = await keyOf();
    const first = await apnsToken('TEAM123456', key, 1_700_000_000_000);
    dropApnsToken('TEAM123456', key.keyId);
    expect(await apnsToken('TEAM123456', key, 1_700_000_001_000)).not.toBe(first);
  });
});

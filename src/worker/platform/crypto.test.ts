import { describe, expect, it } from 'vitest';
import {
  credentialAad,
  decryptSecret,
  decryptSecretText,
  encryptSecret,
  keyedDigest,
  loadKekRing,
  rewrapSecret,
} from './crypto.ts';
import { randomBytes, toBase64 } from './ids.ts';

const kek = () => toBase64(randomBytes(32));

describe('envelope encryption', () => {
  it('round-trips with matching AAD', async () => {
    const ring = await loadKekRing({ KEK_V1: kek() });
    const aad = credentialAad('c1', 'org1', 'connector');
    const envelope = await encryptSecret(ring, 'top secret', aad);
    expect(envelope.kekVersion).toBe(1);
    expect(await decryptSecretText(ring, envelope, aad)).toBe('top secret');
  });

  it('uses a fresh DEK and IV per record', async () => {
    const ring = await loadKekRing({ KEK_V1: kek() });
    const a = await encryptSecret(ring, 'same', 'x');
    const b = await encryptSecret(ring, 'same', 'x');
    expect(a.iv).not.toEqual(b.iv);
    expect(a.wrappedDek).not.toEqual(b.wrappedDek);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('rejects a different AAD, tampered data and a wrong KEK', async () => {
    const ring = await loadKekRing({ KEK_V1: kek() });
    const envelope = await encryptSecret(ring, 'secret', credentialAad('c1', 'o', 'webhook'));
    await expect(
      decryptSecret(ring, envelope, credentialAad('c2', 'o', 'webhook')),
    ).rejects.toThrow(/Decryption failed/);
    const tampered = {
      ...envelope,
      ciphertext: envelope.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b)),
    };
    await expect(
      decryptSecret(ring, tampered, credentialAad('c1', 'o', 'webhook')),
    ).rejects.toThrow(/Decryption failed/);
    const other = await loadKekRing({ KEK_V1: kek() });
    await expect(
      decryptSecret(other, envelope, credentialAad('c1', 'o', 'webhook')),
    ).rejects.toThrow(/Decryption failed/);
  });

  it('encrypts with the newest KEK and still reads old records; rewrap upgrades them', async () => {
    const v1 = kek();
    const old = await loadKekRing({ KEK_V1: v1 });
    const aad = credentialAad('c1', null, 'pass_signer');
    const envelope = await encryptSecret(old, 'k', aad);
    const ring = await loadKekRing({ KEK_V1: v1, KEK_V2: kek() });
    expect(ring.current).toBe(2);
    expect(await decryptSecretText(ring, envelope, aad)).toBe('k');
    const rewrapped = await rewrapSecret(ring, envelope, aad);
    expect(rewrapped.kekVersion).toBe(2);
    expect(rewrapped.ciphertext).toEqual(envelope.ciphertext);
    expect(await decryptSecretText(ring, rewrapped, aad)).toBe('k');
  });

  it('fails clearly without a KEK or with a bad one', async () => {
    await expect(loadKekRing({})).rejects.toThrow(/KEK/);
    await expect(loadKekRing({ KEK_V1: toBase64(randomBytes(16)) })).rejects.toThrow(/32 bytes/);
  });
});

describe('keyedDigest', () => {
  it('is stable per key, label and value, and differs across each', async () => {
    const env = { KEK_V1: kek() };
    const a = await keyedDigest(env, 'counter.a', 'x@example.test');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyedDigest(env, 'counter.a', 'x@example.test')).toBe(a);
    expect(await keyedDigest(env, 'counter.b', 'x@example.test')).not.toBe(a);
    expect(await keyedDigest(env, 'counter.a', 'y@example.test')).not.toBe(a);
    expect(await keyedDigest({ KEK_V1: kek() }, 'counter.a', 'x@example.test')).not.toBe(a);
  });

  it('is not the bare hash of the value', async () => {
    const value = 'x@example.test';
    const bare = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const hex = [...new Uint8Array(bare)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(await keyedDigest({ KEK_V1: kek() }, 'counter.a', value)).not.toBe(hex.slice(0, 32));
  });

  it('keeps counting under the oldest KEK when a newer one is added', async () => {
    const v1 = kek();
    expect(await keyedDigest({ KEK_V1: v1, KEK_V2: kek() }, 'counter.a', 'x')).toBe(
      await keyedDigest({ KEK_V1: v1 }, 'counter.a', 'x'),
    );
  });
});

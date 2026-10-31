import { describe, expect, it } from 'vitest';
import {
  credentialAad,
  decryptSecret,
  decryptSecretText,
  encryptSecret,
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
    ).rejects.toThrow();
    const tampered = {
      ...envelope,
      ciphertext: envelope.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b)),
    };
    await expect(
      decryptSecret(ring, tampered, credentialAad('c1', 'o', 'webhook')),
    ).rejects.toThrow();
    const other = await loadKekRing({ KEK_V1: kek() });
    await expect(
      decryptSecret(other, envelope, credentialAad('c1', 'o', 'webhook')),
    ).rejects.toThrow();
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

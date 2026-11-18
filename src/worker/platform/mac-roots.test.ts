import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  derivedHmacKey,
  encryptSecret,
  importKek,
  isKeyEnvName,
  keyedDigest,
  loadKekRing,
  macKeyVersion,
} from './crypto.ts';
import { toBase64 } from './ids.ts';
import { derivedMacKey, extractMacRoot, macRootAgrees, macRootVersions } from './mac-roots.ts';

const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const hex = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('hex');
const mac = async (key: CryptoKey, text = 'm') =>
  hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
const unhex = (h: string) => Buffer.from(h, 'hex');

describe('HKDF by hand (RFC 5869, test case 1)', () => {
  // IKM 0x0b x 22, salt 000102..0c, info f0..f9, L 42. The first 32 bytes of OKM are T(1).
  const ikm = unhex('0b'.repeat(22));
  const salt = unhex('000102030405060708090a0b0c');
  const info = unhex('f0f1f2f3f4f5f6f7f8f9');
  const prk = '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5';
  const t1 = '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf';
  const hmac = async (key: Uint8Array, data: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
          'raw',
          key as BufferSource,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        ),
        data as BufferSource,
      ),
    );

  it('extract is HMAC(salt, ikm) and expand is HMAC(prk, info || 0x01)', async () => {
    const extracted = await hmac(salt, ikm);
    expect(hex(extracted.buffer as ArrayBuffer)).toBe(prk);
    const expand = await hmac(extracted, Buffer.concat([info, Buffer.from([1])]));
    expect(hex(expand.buffer as ArrayBuffer)).toBe(t1);
  });

  it('WebCrypto HKDF yields the same first block, so by-hand Expand matches derivedHmacKey', async () => {
    const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      material,
      256,
    );
    expect(hex(bits)).toBe(t1);
  });
});

describe('extracted MAC root', () => {
  it('derives the same key as the KEK for any label', async () => {
    const one = kek(1);
    const root = await extractMacRoot(one);
    expect(root).not.toBe(one);
    for (const label of ['a', 'scan-pin', 'pass-credential-tombstone-v1', '', 'label with ünïcode'])
      expect(await mac(await derivedMacKey({ MAC_ROOT_V1: root }, 1, label))).toBe(
        await mac(await derivedMacKey({ KEK_V1: one }, 1, label)),
      );
  });

  it('is not usable as a KEK', async () => {
    const root = await extractMacRoot(kek(1));
    // Same bytes length, but it unwraps nothing: the ring does not read MAC_ROOT_V<n>.
    const { loadKekRing } = await import('./crypto.ts');
    await expect(loadKekRing({ MAC_ROOT_V1: root })).rejects.toThrow('No KEK configured');
  });

  it('prefers the KEK when both are set, and reports agreement', async () => {
    const good = await extractMacRoot(kek(1));
    const wrong = await extractMacRoot(kek(9));
    expect(await macRootAgrees({ KEK_V1: kek(1), MAC_ROOT_V1: good }, 1)).toBe(true);
    expect(await macRootAgrees({ KEK_V1: kek(1), MAC_ROOT_V1: wrong }, 1)).toBe(false);
    expect(await macRootAgrees({ KEK_V1: kek(1), MAC_ROOT_V1: 'AAAA' }, 1)).toBe(false);
    expect(await macRootAgrees({ KEK_V1: kek(1) }, 1)).toBeNull();
    expect(await macRootAgrees({ MAC_ROOT_V1: good }, 1)).toBeNull();
    const env = { KEK_V1: kek(1), MAC_ROOT_V1: wrong };
    expect(await mac(await derivedMacKey(env, 1, 'x'))).toBe(
      await mac(await derivedMacKey({ KEK_V1: kek(1) }, 1, 'x')),
    );
  });

  it('refuses a missing version and a malformed value', async () => {
    await expect(derivedMacKey({ KEK_V2: kek(2) }, 1, 'x')).rejects.toThrow('KEK version 1');
    await expect(
      derivedMacKey({ MAC_ROOT_V1: toBase64(new Uint8Array(16)) }, 1, 'x'),
    ).rejects.toThrow('32 bytes');
  });
});

describe('the oldest root and the pins', () => {
  it('lists KEKs and roots together; the oldest root survives removing KEK_V1', async () => {
    const root = await extractMacRoot(kek(1));
    const env = { KEK_V2: kek(2), MAC_ROOT_V1: root };
    expect(macRootVersions(env)).toEqual([1, 2]);
    expect(macKeyVersion(env)).toBe(1);
    expect(macKeyVersion({ ...env, MAC_KEY_VERSION: '2' })).toBe(2);
    const full = { KEK_V1: kek(1), KEK_V2: kek(2) };
    for (const label of ['pass-credential-tombstone-v1', 'scan-pin', 'capability-token.v1'])
      expect(await mac(await derivedHmacKey(env, label))).toBe(
        await mac(await derivedHmacKey(full, label)),
      );
    expect(await keyedDigest(env, 'counter.magic-ip.v1', 'x')).toBe(
      await keyedDigest(full, 'counter.magic-ip.v1', 'x'),
    );
    expect(await mac(await derivedHmacKey(env, 'scan-pin', 1))).toBe(
      await mac(await derivedHmacKey(full, 'scan-pin', 1)),
    );
  });

  it('keeps a root in the key environment that callers snapshot', () => {
    expect(isKeyEnvName('MAC_ROOT_V1')).toBe(true);
    expect(isKeyEnvName('MAC_ROOT_V')).toBe(false);
  });
});

describe('root 1 is explicit', () => {
  it('fails, never drifts to the next root, when root 1 is gone', async () => {
    const env = { KEK_V2: kek(2) };
    expect(macKeyVersion(env)).toBe(1);
    for (const label of ['pass-credential-tombstone-v1', 'scan-pin', 'counter.magic-ip.v1'])
      await expect(derivedHmacKey(env, label)).rejects.toThrow('KEK version 1');
    // With a pin it still derives from the pinned root.
    expect(await mac(await derivedHmacKey({ ...env, MAC_KEY_VERSION: '2' }, 'scan-pin'))).toBe(
      await mac(await derivedMacKey(env, 2, 'scan-pin')),
    );
  });

  it('reads only versions that start at 1 without a leading zero', () => {
    const env = {
      KEK_V0: kek(1),
      KEK_V01: kek(1),
      KEK_V3: kek(3),
      MAC_ROOT_V07: kek(1),
      MAC_ROOT_V2: kek(2),
    };
    expect(macRootVersions(env)).toEqual([2, 3]);
    for (const name of ['KEK_V0', 'KEK_V01', 'MAC_ROOT_V0', 'MAC_ROOT_V007'])
      expect(isKeyEnvName(name)).toBe(false);
  });
});

describe('a MAC root is not a key encryption key', () => {
  it('cannot unwrap a DEK, even as raw AES key material', async () => {
    const one = kek(1);
    const ring = await loadKekRing({ KEK_V1: one });
    const aad = 'id|org|kind';
    const sealed = await encryptSecret(ring, 'secret', aad);
    const root = await extractMacRoot(one);
    // The 32 bytes of the root, tried as the KEK of the same envelope.
    const imposter = { current: 1, keys: new Map([[1, await importKek(root)]]) };
    await expect(decryptSecret(imposter, sealed, aad)).rejects.toThrow();
    // And the real KEK still opens it.
    expect(new TextDecoder().decode(await decryptSecret(ring, sealed, aad))).toBe('secret');
  });
});

// A new derived label is covered by this test the day it lands: every quoted word in a file that calls
// derivedHmacKey or keyedDigest is tried (a string that is not a label passes the check just as well).
describe('every label in the tree', () => {
  const sources = import.meta.glob(['../**/*.ts', '!../**/*.test.ts', '!../**/*fixtures.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const labels = new Set<string>();
  for (const text of Object.values(sources))
    if (/\b(derivedHmacKey|keyedDigest)\(|MAC_KEYS\b/.test(text))
      for (const m of text.matchAll(/'([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)'/g))
        labels.add(m[1] as string);

  it('finds the labels it should', () => {
    for (const known of [
      'pass-credential-tombstone-v1',
      'scan-pin',
      'scan-retention-proof.v1',
      'counter.magic-ip.v1',
      'connection.webhook.item-ref.v1',
      'capability-token.v1',
    ])
      expect(labels.has(known) || [...labels].some((l) => l.startsWith(known.slice(0, 12)))).toBe(
        true,
      );
    expect(labels.size).toBeGreaterThan(25);
  });

  it('derives identically from KEK_V1 and from its extracted root', async () => {
    const from = { KEK_V1: kek(7) };
    const root = { MAC_ROOT_V1: await extractMacRoot(kek(7)) };
    for (const label of labels) {
      expect(await mac(await derivedHmacKey(root, label)), label).toBe(
        await mac(await derivedHmacKey(from, label)),
      );
    }
  });
});

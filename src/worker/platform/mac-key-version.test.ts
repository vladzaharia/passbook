import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../test/helpers/index.ts';
import { tokenKeys, tokenMac, tokenMacs, tokenMatches } from './capability-token.ts';
import { derivedHmacKey, isKeyEnvName, macKeyVersion, macPreviousVersion } from './crypto.ts';
import { macKeyProblems } from './mac-key-config.ts';

const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const mac = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('m'))).toString('hex');

describe('MAC root version', () => {
  it('defaults to the oldest KEK, so adding a newer KEK changes no MAC', async () => {
    const one = await makeEnv({ KEK_V1: kek(1) });
    const two = { ...one, KEK_V2: kek(2) };
    expect(macKeyVersion(one)).toBe(1);
    expect(macKeyVersion(two)).toBe(1);
    expect(await mac(await derivedHmacKey(two, 'scan-pin'))).toBe(
      await mac(await derivedHmacKey(one, 'scan-pin')),
    );
  });

  it('moves only the rotatable labels; retained-evidence labels stay on the oldest KEK', async () => {
    const base = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    const pinned = { ...base, MAC_KEY_VERSION: '2' };
    for (const label of [
      'pass-credential-tombstone-v1',
      'scan-retention-proof.v1',
      'connection.webhook.item-ref.v1',
    ])
      expect(await mac(await derivedHmacKey(pinned, label))).toBe(
        await mac(await derivedHmacKey(base, label)),
      );
    for (const label of [
      'capability-token.v1',
      'apple-auth-token.v1',
      'scan-pin',
      'scan-pair-code.v1',
      'scan-asset-grant-v2',
    ])
      expect(await mac(await derivedHmacKey(pinned, label))).not.toBe(
        await mac(await derivedHmacKey(base, label)),
      );
  });

  it('derives from the pinned version and keeps the labels apart', async () => {
    const base = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    const pinned = { ...base, MAC_KEY_VERSION: '2' };
    expect(macKeyVersion(pinned)).toBe(2);
    const v1 = await mac(await derivedHmacKey(base, 'scan-pin'));
    const v2 = await mac(await derivedHmacKey(pinned, 'scan-pin'));
    expect(v2).not.toBe(v1);
    expect(await mac(await derivedHmacKey(base, 'scan-pin', 2))).toBe(v2);
    expect(await mac(await derivedHmacKey(pinned, 'scan-pin', 1))).toBe(v1);
    expect(await mac(await derivedHmacKey(pinned, 'other'))).not.toBe(v2);
  });

  it('refuses a version without a KEK or a malformed pin', async () => {
    const base = await makeEnv({ KEK_V1: kek(1) });
    await expect(derivedHmacKey({ ...base, MAC_KEY_VERSION: '3' }, 'scan-pin')).rejects.toThrow(
      'KEK version 3',
    );
    expect(() => macKeyVersion({ ...base, MAC_KEY_VERSION: 'two' })).toThrow('MAC_KEY_VERSION');
    expect(() => macKeyVersion({ ...base, MAC_KEY_VERSION: '0' })).toThrow('MAC_KEY_VERSION');
  });

  it('reports a previous version only while it differs from the root', async () => {
    const base = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    expect(macPreviousVersion(base)).toBeNull();
    expect(
      macPreviousVersion({ ...base, MAC_KEY_VERSION: '2', MAC_KEY_VERSION_PREVIOUS: '1' }),
    ).toBe(1);
    expect(macPreviousVersion({ ...base, MAC_KEY_VERSION_PREVIOUS: '1' })).toBeNull();
  });

  it('is part of the key environment that callers snapshot', () => {
    for (const name of ['KEK_V1', 'KEK_V12', 'MAC_KEY_VERSION', 'MAC_KEY_VERSION_PREVIOUS'])
      expect(isKeyEnvName(name)).toBe(true);
    expect(isKeyEnvName('KEK_V')).toBe(false);
    expect(isKeyEnvName('DB')).toBe(false);
  });
});

describe('token MACs across a rotation', () => {
  it('accepts the previous root while it is set and only the new one after', async () => {
    const before = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    const during = { ...before, MAC_KEY_VERSION: '2', MAC_KEY_VERSION_PREVIOUS: '1' };
    const after = { ...before, MAC_KEY_VERSION: '2' };
    const old = await tokenMac(before, 'pass', 'link-token');
    const moved = await tokenMac(after, 'pass', 'link-token');
    expect(moved).not.toBe(old);
    expect(await tokenMacs(during, 'pass', 'link-token')).toEqual([moved, old]);
    expect(await tokenKeys(during, 'pass', 'link-token')).toEqual([moved, 'link-token', old]);
    expect(await tokenMatches(during, 'pass', old, 'link-token')).toBe(true);
    expect(await tokenMatches(during, 'pass', moved, 'link-token')).toBe(true);
    expect(await tokenMatches(after, 'pass', moved, 'link-token')).toBe(true);
    expect(await tokenMatches(after, 'pass', old, 'link-token')).toBe(false);
    expect(await tokenMatches(during, 'pass', old, 'other-token')).toBe(false);
    // A purpose never verifies as another's.
    expect(await tokenMatches(during, 'apple-auth', old, 'link-token')).toBe(false);
  });
});

describe('macKeyProblems', () => {
  it('accepts unset values and a distinct pair of configured KEKs', () => {
    expect(macKeyProblems({}, [1])).toEqual([]);
    expect(macKeyProblems({ pin: '2', previous: '1' }, [1, 2])).toEqual([]);
  });

  it('names every problem', () => {
    expect(macKeyProblems({ pin: '3' }, [1, 2])).toEqual([
      'MAC_KEY_VERSION=3 names a KEK that is not set (KEK_V3).',
    ]);
    expect(macKeyProblems({ pin: '0', previous: 'x' }, [1])).toHaveLength(2);
    expect(macKeyProblems({ pin: '2', previous: '2' }, [1, 2])).toEqual([
      'MAC_KEY_VERSION and MAC_KEY_VERSION_PREVIOUS must differ.',
    ]);
    // Without the secrets (a config-only check) existence is not judged.
    expect(macKeyProblems({ pin: '7' }, null)).toEqual([]);
  });
});

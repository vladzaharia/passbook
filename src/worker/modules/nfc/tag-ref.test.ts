import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { canonicalUid, normalizeTagId, tagRef } from './tag-ref.ts';

const UID = '04a1b2c3d4e5f6';

describe('tagRef', () => {
  it('is a stable keyed ref whose hint is its first four hex digits, upper case', async () => {
    const env = await makeEnv();
    const a = await tagRef(env, 'org-1', 'live', UID);
    expect(a.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hint).toBe(a.ref.slice(0, 4).toUpperCase());
    expect(await tagRef(env, 'org-1', 'live', UID.toUpperCase())).toEqual(a);
    expect(a.ref).not.toContain(UID);
  });

  it('differs by mode and by org', async () => {
    const env = await makeEnv();
    const live = await tagRef(env, 'org-1', 'live', UID);
    expect((await tagRef(env, 'org-1', 'test', UID)).ref).not.toBe(live.ref);
    expect((await tagRef(env, 'org-2', 'live', UID)).ref).not.toBe(live.ref);
  });

  it('stays on the oldest KEK when the MAC root moves', async () => {
    const kek = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
    const base = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    const moved = { ...base, MAC_KEY_VERSION: '2' };
    expect((await tagRef(moved, 'o', 'live', UID)).ref).toBe(
      (await tagRef(base, 'o', 'live', UID)).ref,
    );
  });

  it('refuses a UID of the wrong length or with other characters', () => {
    for (const bad of ['', '04a1', '04a1b2c3d4e5f', 'zz'.repeat(7), '04a1b2c3d4e5f6a'])
      expect(() => canonicalUid(bad)).toThrow(RangeError);
  });
});

describe('normalizeTagId', () => {
  it('maps the forms a reader types to one canonical UID', () => {
    for (const typed of [
      '04:A1:B2:C3:D4:E5:F6',
      '04-a1-b2-c3-d4-e5-f6',
      '0x04a1b2c3d4e5f6',
      ' 04A1B2C3D4E5F6 ',
    ])
      expect(normalizeTagId(typed)).toBe(UID);
  });

  it('reverses byte order and reads decimal 4 byte IDs', () => {
    expect(normalizeTagId('f6e5d4c3b2a104', 'hex-reversed')).toBe(UID);
    expect(normalizeTagId('3735928559', 'decimal')).toBe('deadbeef');
    expect(normalizeTagId('3735928559', 'decimal-reversed')).toBe('efbeadde');
  });

  it('answers null for anything that is not a tag ID', () => {
    expect(normalizeTagId('hello')).toBeNull();
    expect(normalizeTagId('04a1')).toBeNull();
    expect(normalizeTagId('99999999999', 'decimal')).toBeNull();
    expect(normalizeTagId('5000000000', 'decimal')).toBeNull();
import { canonicalUid, normalizeTagId, readableUid, tagRef } from './tag-ref.ts';

const UID = '04a1b2c3d4e5f6';

describe('tagRef', () => {
  it('is a stable keyed ref whose hint is its first four hex digits, upper case', async () => {
    const env = await makeEnv();
    const a = await tagRef(env, 'org-1', 'live', UID);
    expect(a.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hint).toBe(a.ref.slice(0, 4).toUpperCase());
    expect(await tagRef(env, 'org-1', 'live', UID.toUpperCase())).toEqual(a);
    expect(a.ref).not.toContain(UID);
  });

  it('differs by mode and by org', async () => {
    const env = await makeEnv();
    const live = await tagRef(env, 'org-1', 'live', UID);
    expect((await tagRef(env, 'org-1', 'test', UID)).ref).not.toBe(live.ref);
    expect((await tagRef(env, 'org-2', 'live', UID)).ref).not.toBe(live.ref);
  });

  it('stays on the oldest KEK when the MAC root moves', async () => {
    const kek = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
    const base = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    const moved = { ...base, MAC_KEY_VERSION: '2' };
    expect((await tagRef(moved, 'o', 'live', UID)).ref).toBe(
      (await tagRef(base, 'o', 'live', UID)).ref,
    );
  });

  it('refuses a UID of the wrong length or with other characters', () => {
    for (const bad of ['', '04a1', '04a1b2c3d4e5f', 'zz'.repeat(7), '04a1b2c3d4e5f6a'])
      expect(() => canonicalUid(bad)).toThrow(RangeError);
  });
});

describe('normalizeTagId', () => {
  it('maps the forms a reader types to one canonical UID', () => {
    for (const typed of [
      '04:A1:B2:C3:D4:E5:F6',
      '04-a1-b2-c3-d4-e5-f6',
      '0x04a1b2c3d4e5f6',
      ' 04A1B2C3D4E5F6 ',
    ])
      expect(normalizeTagId(typed)).toBe(UID);
  });

  it('reverses byte order and reads decimal 4 byte IDs', () => {
    expect(normalizeTagId('f6e5d4c3b2a104', 'hex-reversed')).toBe(UID);
    expect(normalizeTagId('3735928559', 'decimal')).toBe('deadbeef');
    expect(normalizeTagId('3735928559', 'decimal-reversed')).toBe('efbeadde');
  });

  it('answers null for anything that is not a tag ID', () => {
    expect(normalizeTagId('hello')).toBeNull();
    expect(normalizeTagId('04a1')).toBeNull();
    expect(normalizeTagId('99999999999', 'decimal')).toBeNull();
    expect(normalizeTagId('5000000000', 'decimal')).toBeNull();
  });
});

describe('readableUid', () => {
  it('names a fixed tag and refuses a random ID', () => {
    expect(readableUid({ uid: '04A1B2C3D4E5F6' })).toBe('04a1b2c3d4e5f6');
    expect(readableUid({ uid: '04a1b2c3' })).toBe('04a1b2c3');
    expect(readableUid({ uid: '04a1b2c3', uidRandom: true })).toBeNull();
    expect(readableUid({ uid: '08a1b2c3' })).toBeNull();
    expect(readableUid({ uid: '08a1b2c3d4e5f6' })).toBe('08a1b2c3d4e5f6');
    expect(readableUid({})).toBeNull();
    expect(readableUid({ uid: '04a1' })).toBeNull();
  });
});

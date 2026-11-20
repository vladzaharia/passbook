import { describe, expect, it } from 'vitest';
import { assuranceOfSystem, recogniseTag, systemById, TAG_SYSTEMS } from './registry.ts';

const SUN =
  'https://passbook.mobile/t/abc123?p=00112233445566778899aabbccddeeff&m=0011223344556677';
const base = { tech: 'a', source: 'native' } as const;
const env = { PUBLIC_BASE_URL: 'https://passbook.mobile', REDIRECT_HOSTS: 'wallet.plrs.im' };
const recognise = (read: Parameters<typeof recogniseTag>[0]) => recogniseTag(read, env);

describe('tag systems registry', () => {
  it('looks a system up by id', () => {
    expect(TAG_SYSTEMS.map((s) => s.id)).toEqual(['sun', 'uid']);
    expect(systemById('uid')).toMatchObject({ assurance: 'basic', ready: true });
    expect(systemById('sun')).toMatchObject({ assurance: 'secure', ready: true });
    expect(systemById('desfire')).toBeUndefined();
    expect(assuranceOfSystem('desfire')).toBe('secure');
  });

  it('a fixed UID is Basic, lower-cased', () => {
    expect(recognise({ ...base, uid: '04A1B2C3' })).toEqual({ system: 'uid', uid: '04a1b2c3' });
    expect(recognise({ ...base, uid: '04a1b2c3', ndef: { type: 'T', value: 'hello' } })).toEqual({
      system: 'uid',
      uid: '04a1b2c3',
    });
  });

  it('a random or absent UID is no tag', () => {
    expect(recognise({ ...base, uid: '04a1b2c3', uidRandom: true })).toBeNull();
    expect(recognise({ ...base, uid: '08a1b2c3' })).toBeNull();
    expect(recognise({ ...base, ndef: { type: 'T', value: 'PASS-CODE' } })).toBeNull();
  });

  it('a SUN URL goes to the SUN system even with a UID', () => {
    expect(recognise({ ...base, uid: '04a1b2c3d4e5f6', ndef: { type: 'U', value: SUN } })).toEqual({
      system: 'sun',
    });
    expect(recognise({ ...base, ndef: { type: 'U', value: SUN } })).toEqual({ system: 'sun' });
    const plain = 'https://passbook.mobile/p/abc?x=1';
    expect(recognise({ ...base, uid: '04a1b2c3', ndef: { type: 'U', value: plain } })).toEqual({
      system: 'uid',
      uid: '04a1b2c3',
    });
  });

  it('a SUN URL is ours: our host or a redirect host, parsed as a URL', () => {
    const on = (host: string) => `https://${host}/t/abc123?p=${'a'.repeat(32)}&m=${'b'.repeat(16)}`;
    const read = (value: string) =>
      ({ ...base, uid: '04a1b2c3d4e5f6', ndef: { type: 'U', value } }) as const;
    expect(recognise(read(on('wallet.plrs.im')))).toEqual({ system: 'sun' });
    expect(recognise(read(on('PassBook.mobile')))).toEqual({ system: 'sun' });
    // Another host, a look-alike, a userinfo trick and http are not ours: the read is the tag's UID, nothing more.
    for (const value of [
      on('evil.example'),
      on('passbook.mobile.evil.example'),
      on('passbook.mobile@evil.example'),
      on('passbook.mobile:444'),
      on('passbook.mobile').replace('https', 'http'),
    ])
      expect(recognise(read(value))).toEqual({ system: 'uid', uid: '04a1b2c3d4e5f6' });
  });

  it('a SUN URL carries no identity of its own', () => {
    const sun = TAG_SYSTEMS.find((s) => s.id === 'sun');
    expect(sun).toBeDefined();
    expect(sun && 'identify' in sun).toBe(false);
  });
});

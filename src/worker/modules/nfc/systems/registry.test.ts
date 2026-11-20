import { describe, expect, it } from 'vitest';
import { assuranceOfSystem, recogniseTag, systemById, TAG_SYSTEMS } from './registry.ts';

const SUN =
  'https://passbook.mobile/t/abc123?p=00112233445566778899aabbccddeeff&m=0011223344556677';
const base = { tech: 'a', source: 'native' } as const;

describe('tag systems registry', () => {
  it('looks a system up by id', () => {
    expect(TAG_SYSTEMS.map((s) => s.id)).toEqual(['sun', 'uid']);
    expect(systemById('uid')).toMatchObject({ assurance: 'basic', ready: true });
    expect(systemById('sun')).toMatchObject({ assurance: 'secure', ready: false });
    expect(systemById('desfire')).toBeUndefined();
    expect(assuranceOfSystem('desfire')).toBe('secure');
  });

  it('a fixed UID is Basic, lower-cased', () => {
    expect(recogniseTag({ ...base, uid: '04A1B2C3' })).toEqual({ system: 'uid', uid: '04a1b2c3' });
    expect(recogniseTag({ ...base, uid: '04a1b2c3', ndef: { type: 'T', value: 'hello' } })).toEqual(
      {
        system: 'uid',
        uid: '04a1b2c3',
      },
    );
  });

  it('a random or absent UID is no tag', () => {
    expect(recogniseTag({ ...base, uid: '04a1b2c3', uidRandom: true })).toBeNull();
    expect(recogniseTag({ ...base, uid: '08a1b2c3' })).toBeNull();
    expect(recogniseTag({ ...base, ndef: { type: 'T', value: 'PASS-CODE' } })).toBeNull();
  });

  it('a SUN URL goes to the SUN system even with a UID', () => {
    expect(
      recogniseTag({ ...base, uid: '04a1b2c3d4e5f6', ndef: { type: 'U', value: SUN } }),
    ).toEqual({
      system: 'sun',
    });
    expect(recogniseTag({ ...base, ndef: { type: 'U', value: SUN } })).toEqual({ system: 'sun' });
    const plain = 'https://passbook.mobile/p/abc?x=1';
    expect(recogniseTag({ ...base, uid: '04a1b2c3', ndef: { type: 'U', value: plain } })).toEqual({
      system: 'uid',
      uid: '04a1b2c3',
    });
  });
});

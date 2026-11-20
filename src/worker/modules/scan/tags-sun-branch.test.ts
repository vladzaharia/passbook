import { beforeAll, describe, expect, it } from 'vitest';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

const SUN = {
  uid: '04a1b2c3d4e5f6',
  tech: 'isodep',
  source: 'native',
  ndef: {
    type: 'U',
    value: 'https://passbook.mobile/t/abc123?p=00112233445566778899aabbccddeeff&m=0011223344556677',
  },
};

describe('a SUN-shaped read of a keyset the org does not have', () => {
  it('inspect refuses it and stores nothing', async () => {
    const s = await f.desk();
    const res = await f.inspect(s, SUN);
    expect(await res.json()).toMatchObject({ state: 'invalid' });
    expect(await f.count('SELECT count(*) AS n FROM nfc_tags')).toBe(0);
  });

  it('assign refuses it and stores nothing', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const res = await f.bind(s, { card, tag: SUN });
    expect(await res.json()).toMatchObject({ code: 'TAG_CHECK_FAILED' });
    expect(await f.count('SELECT count(*) AS n FROM nfc_tags')).toBe(0);
  });
});

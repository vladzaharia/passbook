import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { act, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { tagsOn } from './tags-resolve-test-fixtures.ts';
import { key } from './test-kit.ts';

beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
});

const SUN = {
  tag: {
    uid: '04a1b2c3d4e5f6',
    tech: 'isodep',
    source: 'native',
    ndef: {
      type: 'U',
      value:
        'https://passbook.mobile/t/abc123?p=00112233445566778899aabbccddeeff&m=0011223344556677',
    },
  },
  method: 'nfc',
};
const level = (value: string) =>
  run(
    kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'nfc', ?, 1)`,
    [kit.org.id, JSON.stringify(value)],
  );

describe('a SUN read below the plan Secure level', () => {
  it('is tag_not_allowed at resolve and act, and stays tag_invalid at Secure', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const resolve = async () =>
      out(
        await kit.post(scanner.headers, '/resolve', {
          idempotencyKey: key(),
          input: SUN,
          clientTs: kit.clock.now(),
        }),
      );
    const doAct = async () => out(await act(scanner.headers, SUN));
    await level('secure');
    expect(await resolve()).toMatchObject({ reason: 'tag_invalid' });
    expect(await doAct()).toMatchObject({ reason: 'tag_invalid' });
    for (const below of ['basic', 'off']) {
      await level(below);
      expect(await resolve()).toMatchObject({ kind: 'refused', reason: 'tag_not_allowed' });
      expect(await doAct()).toMatchObject({ kind: 'refused', reason: 'tag_not_allowed' });
    }
  });
});

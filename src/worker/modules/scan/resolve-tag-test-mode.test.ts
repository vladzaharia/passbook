import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { act, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { tagsOn } from './tags-resolve-test-fixtures.ts';
import { key } from './test-kit.ts';

// Test-mode waiver (billing AD5): nfc is not waived (E7 revisits it per tag write), so a SUN read below
// the plan's Secure level is refused in both modes.

beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
});

const SUN = {
  tag: {
    uid: '04a1b2c3d4e5f7',
    tech: 'isodep',
    source: 'native',
    ndef: {
      type: 'U',
      value:
        'https://passbook.mobile/t/abc124?p=00112233445566778899aabbccddeeff&m=0011223344556677',
    },
  },
  method: 'nfc',
};

describe('a SUN read below Secure, by mode', () => {
  it('is tag_not_allowed in Live and in Test', async () => {
    await run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'nfc', '"basic"', 1)`,
      [kit.org.id],
    );
    for (const mode of ['live', 'test'] as const) {
      const scanner = await kit.scanner({ templateIds: [tpl], mode });
      const resolve = await out(
        await kit.post(scanner.headers, '/resolve', {
          idempotencyKey: key(),
          input: SUN,
          clientTs: kit.clock.now(),
        }),
      );
      const acted = await out(await act(scanner.headers, SUN));
      expect(resolve, mode).toMatchObject({ reason: 'tag_not_allowed' });
      expect(acted, mode).toMatchObject({ reason: 'tag_not_allowed' });
    }
  });
});

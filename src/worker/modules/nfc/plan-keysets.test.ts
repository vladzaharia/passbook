import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';
import { createKeysetGrant } from './repo-keysets-write.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const NEW = { name: 'Staff badges', generate: true };
const level = (orgId: string, value: string) =>
  run(
    f.kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'nfc', ?, 1)`,
    [orgId, JSON.stringify(value)],
  );
const create = async (t: Awaited<ReturnType<typeof f.org>>) =>
  f.call(t.admin.headers, 'POST', `/keysets?orgId=${t.org.id}`, NEW);

describe('the nfc level: Secure keysets', () => {
  it('a legacy org (Secure) creates a keyset as before', async () => {
    expect((await create(await f.org())).status).toBe(201);
  });

  it('refuses a keyset below Secure with FEATURE_NOT_INCLUDED, and creates one at Secure', async () => {
    const t = await f.org();
    for (const value of ['off', 'basic']) {
      await level(t.org.id, value);
      const res = await create(t);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'nfc' });
    }
    await level(t.org.id, 'secure');
    expect((await create(t)).status).toBe(201);
  });

  it('a downgrade pauses: the keyset stays listed and can still rotate and disable', async () => {
    const t = await f.org();
    const made = (await (await create(t)).json()) as { id: string };
    await level(t.org.id, 'off');
    const list = (await (
      await f.call(t.admin.headers, 'GET', `/keysets?orgId=${t.org.id}`)
    ).json()) as { items: { id: string }[] };
    expect(list.items.map((k) => k.id)).toEqual([made.id]);
    const rotated = await f.call(t.admin.headers, 'POST', `/keysets/${made.id}/rotate`, {
      generate: true,
    });
    expect(rotated.status).toBe(200);
    const disabled = await f.call(t.admin.headers, 'POST', `/keysets/${made.id}/disable`);
    expect(disabled.status).toBe(200);
  });

  it('the grant is the backstop: a create that got past the service check still refuses', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    await level(t.org.id, 'basic');
    const grant = () =>
      createKeysetGrant(f.kit.ctx, authority, {
        id: f.kit.ctx.ids.id(),
        name: 'Late',
        slug: `late-${f.kit.ctx.ids.token(4)}`.toLowerCase(),
        diversify: false,
        perTag: false,
        first: {
          id: f.kit.ctx.ids.id(),
          version: 1,
          envelope: {
            kekVersion: 1,
            iv: new Uint8Array(12),
            wrappedDek: new Uint8Array(8),
            ciphertext: new Uint8Array(8),
          },
        },
      });
    await expect(grant().commit()).rejects.toMatchObject({ code: 'FEATURE_NOT_INCLUDED' });
  });
});

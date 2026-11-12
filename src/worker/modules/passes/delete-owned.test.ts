// Deleting an owned pass clears the owner behind an attach block (the 0055 trigger refuses it otherwise).
import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { runAttachHookA } from '../holders/service.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { deletePass } from './service.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
}, 60_000);

const del = (id: string) =>
  app.request(
    `https://wallet.test/api/v1/passes/${id}`,
    { method: 'DELETE', headers: auth.admin() },
    kit.env,
  );
const deletedRow = (id: string) =>
  first<{ deleted: number; owner: string | null }>(
    kit.env.DB,
    'SELECT deleted_at IS NOT NULL AS deleted, owner_user_id AS owner FROM passes WHERE id = ?',
    [id],
  );
const block = (passId: string, userId: string) =>
  first(kit.env.DB, 'SELECT 1 AS ok FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
    passId,
    userId,
  ]);

async function ownedPass() {
  const email = `owned-${kit.fx.ids.token(6).toLowerCase()}@example.test`.replace(
    /[^a-z0-9@.-]/g,
    'x',
  );
  const user = await makeUser(kit.fx, { primaryEmail: email });
  const pass = await kit.pass({ holderEmail: email });
  expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
  return { pass, user };
}

describe('DELETE /passes/:id on an owned pass', () => {
  it('deletes, clears the owner and blocks a re-attach', async () => {
    const { pass, user } = await ownedPass();
    expect((await del(pass.id)).status).toBe(200);
    expect(await deletedRow(pass.id)).toEqual({ deleted: 1, owner: null });
    expect(await block(pass.id, user.id)).toEqual({ ok: 1 });
    expect(await runAttachHookA(jobCtxOf(kit), pass.id)).toBeNull();
    expect(await deletedRow(pass.id)).toEqual({ deleted: 1, owner: null });
  }, 120_000);

  it('finishes a delete whose earlier attempt voided the pass but did not delete it', async () => {
    const { pass, user } = await ownedPass();
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    expect((await del(pass.id)).status).toBe(200);
    expect(await deletedRow(pass.id)).toEqual({ deleted: 1, owner: null });
    expect(await block(pass.id, user.id)).toEqual({ ok: 1 });
  }, 120_000);

  it('a trusted caller without tenant authority deletes the same way', async () => {
    const { pass, user } = await ownedPass();
    await deletePass(jobCtxOf(kit), { type: 'system', id: null }, pass.id, null);
    expect(await deletedRow(pass.id)).toEqual({ deleted: 1, owner: null });
    expect(await block(pass.id, user.id)).toEqual({ ok: 1 });
  }, 120_000);

  it('an unowned pass deletes with no block row', async () => {
    const pass = await kit.pass();
    expect((await del(pass.id)).status).toBe(200);
    expect(await deletedRow(pass.id)).toEqual({ deleted: 1, owner: null });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
  }, 120_000);

  it('a read-only key cannot delete an owned pass and leaves no block', async () => {
    const { pass, user } = await ownedPass();
    const readOnly = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const res = await app.request(
      `https://wallet.test/api/v1/passes/${pass.id}`,
      { method: 'DELETE', headers: readOnly },
      kit.env,
    );
    expect(res.status).toBe(403);
    expect(await deletedRow(pass.id)).toEqual({ deleted: 0, owner: user.id });
    expect(await block(pass.id, user.id)).toBeNull();
  }, 120_000);
});

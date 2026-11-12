// A platform (null-org) API key acts on the org of the pass it names: every write commits under that org.
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let auth: TenantTestAuth;
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
}, 60_000);

type Headers = Record<string, string>;
const call = (method: string, path: string, headers: Headers, body: unknown = {}) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const tag = () => Math.random().toString(36).slice(2, 8);
const holderPass = () => kit.pass({ holderEmail: `platform-${tag()}@example.test` });

describe('a platform API key on a stated org', () => {
  it('updates, voids, unvoids, rotates and deletes', async () => {
    const key = await auth.apiKey({ orgId: null });
    const pass = await kit.pass();
    const update = await call('PATCH', `/passes/${pass.id}`, key, {
      input: { memberName: 'Platform Edit' },
    });
    expect(update.status).toBe(200);
    expect((await call('POST', `/passes/${pass.id}/void`, key)).status).toBe(200);
    expect((await call('POST', `/passes/${pass.id}/unvoid`, key)).status).toBe(200);
    expect((await call('POST', `/passes/${pass.id}/rotate-link`, key)).status).toBe(200);
    expect((await call('DELETE', `/passes/${pass.id}`, key)).status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT deleted_at IS NOT NULL AS d FROM passes WHERE id = ?', [
        pass.id,
      ]),
    ).toEqual({ d: 1 });
  });

  it('removes from Wallet and resends the email to the holder', async () => {
    const key = await auth.apiKey({ orgId: null });
    const pass = await holderPass();
    expect((await call('POST', `/passes/${pass.id}/resend-email`, key)).status).toBe(202);
    expect(
      await first(kit.env.DB, "SELECT 1 AS x FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        pass.id,
      ]),
    ).toEqual({ x: 1 });
    expect((await call('POST', `/passes/${pass.id}/remove`, key)).status).toBe(200);
    expect((await getPass(kit.env.DB, pass.id))?.removedAt).not.toBeNull();
  });

  it('transfers the holder', async () => {
    const key = await auth.apiKey({ orgId: null });
    const pass = await holderPass();
    const to = `platform-new-${tag()}@example.test`;
    const res = await call('POST', '/holders/reassign', key, { passId: pass.id, email: to });
    expect(res.status).toBe(200);
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe(to);
  });

  it('creates and sends a bundle to the holder', async () => {
    const key = await auth.apiKey({ orgId: null });
    const holder = `platform-bundle-${tag()}@example.test`;
    const pass = await kit.pass({ holderEmail: holder });
    const res = await call('POST', '/bundles', key, {
      orgId: kit.org.id,
      name: `Platform ${tag()}`,
      passIds: [pass.id],
      holderEmail: holder,
      sendEmail: true,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await call('POST', `/bundles/${id}/send-email`, key)).status).toBe(202);
  });

  it('is still refused without the scope, and an org key cannot reach another org', async () => {
    const readOnly = await auth.apiKey({ orgId: null, scopes: ['passes:read'] });
    const pass = await kit.pass();
    expect((await call('POST', `/passes/${pass.id}/void`, readOnly)).status).toBe(403);
    const other = await makeOrg(kit.fx);
    const foreign = await auth.apiKey({ orgId: other.id });
    expect((await call('POST', `/passes/${pass.id}/void`, foreign)).status).toBe(404);
    expect((await getPass(kit.env.DB, pass.id))?.status).toBe('active');
  });
});

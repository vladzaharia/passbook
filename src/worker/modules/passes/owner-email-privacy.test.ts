// A tenant reads its own pass's holder_email, never the holder account's global primary email.
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let alias: string;
let primary: string;
let passId: string;
let userId: string;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  const tag = kit.fx.ids
    .token(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x');
  primary = `account-${tag}@example.test`;
  alias = `alias-${tag}@example.test`;
  const user = await makeUser(kit.fx, { primaryEmail: primary });
  userId = user.id;
  await run(
    kit.env.DB,
    "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
    [alias, user.id, kit.clock.now()],
  );
  const pass = await kit.pass({ holderEmail: alias });
  passId = pass.id;
});

const get = (headers: Record<string, string>) =>
  app.request(`https://wallet.test/api/v1/passes/${passId}`, { headers }, kit.env);

async function memberHeaders() {
  const member = await makeUser(kit.fx);
  await grantKitMembership(kit, kit.org.id, member.id, ['org_admin']);
  return {
    ...(await makeSession(kit.fx, { userId: member.id })).headers,
    origin: 'https://wallet.test',
  };
}

describe('pass detail owner email', () => {
  it('gives an org member and an API key the pass holder_email, not the account email', async () => {
    for (const headers of [await memberHeaders(), await auth.apiKey({ orgId: kit.org.id })]) {
      const res = await get(headers);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ownerEmail: string | null; holderEmail: string | null };
      expect(body.holderEmail).toBe(alias);
      expect(body.ownerEmail).toBe(alias);
      expect(JSON.stringify(body)).not.toContain(primary);
    }
  });

  it('gives a platform admin the account email', async () => {
    const body = (await (await get(auth.admin())).json()) as { ownerEmail: string | null };
    expect(body.ownerEmail).toBe(primary);
  });

  it('labels a blocked user without a name as "Account" for tenants and by email for admins', async () => {
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [passId, userId],
    );
    const tenant = (await (await get(await memberHeaders())).json()) as {
      blockedUsers: { id: string; name: string | null }[];
    };
    expect(tenant.blockedUsers).toEqual([{ id: userId, name: 'Account' }]);
    const admin = (await (await get(auth.admin())).json()) as typeof tenant;
    expect(admin.blockedUsers).toEqual([{ id: userId, name: primary }]);
  });
});

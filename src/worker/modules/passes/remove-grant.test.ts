import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoLeakedGrants,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
}, 60_000);

async function operator(orgId = kit.org.id) {
  const user = await makeUser(kit.fx);
  const now = kit.clock.now();
  const invitation = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitation,
      orgId,
      user.primaryEmail,
      '["pass_operator"]',
      kit.fx.ids.token(),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, user.id, invitation, '["pass_operator"]', now],
  );
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  return { membershipId, session };
}

const post = (headers: Record<string, string>, path: string, body: object = {}) =>
  app.request(
    `${ORIGIN}/api/v1/passes${path}`,
    {
      method: 'POST',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );

const removedAt = async (id: string) =>
  (
    await first<{ removed_at: number | null }>(
      kit.env.DB,
      'SELECT removed_at FROM passes WHERE id = ?',
      [id],
    )
  )?.removed_at ?? null;

describe('remove and restore as grants', () => {
  it('removes and restores through a session', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    expect((await post(actor.session.headers, `/${pass.id}/remove`)).status).toBe(200);
    expect(await removedAt(pass.id)).not.toBeNull();
    expect((await post(actor.session.headers, `/${pass.id}/restore`)).status).toBe(200);
    expect(await removedAt(pass.id)).toBeNull();
    await assertNoLeakedGrants(kit.env.DB);
  });

  it('removes through an API key', async () => {
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const pass = await kit.pass();
    expect((await post(key.headers, `/${pass.id}/remove`)).status).toBe(200);
    expect(await removedAt(pass.id)).not.toBeNull();
  });

  it('bulk remove removes each pass', async () => {
    const actor = await operator();
    const [a, b] = [await kit.pass(), await kit.pass()];
    const response = await post(actor.session.headers, '/bulk', {
      action: 'remove',
      ids: [a.id, b.id],
      orgId: kit.org.id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ done: 2 });
    expect(await removedAt(a.id)).not.toBeNull();
    expect(await removedAt(b.id)).not.toBeNull();
  });

  it('refuses a revoked membership with 403 and removes nothing', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      actor.membershipId,
    ]);
    expect((await post(actor.session.headers, `/${pass.id}/remove`)).status).toBe(403);
    expect(await removedAt(pass.id)).toBeNull();
  });

  it('refuses a suspended org with ORG_ACCESS_CHANGED', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    try {
      const response = await post(actor.session.headers, `/${pass.id}/remove`);
      expect(response.status).toBe(403);
      expect(await removedAt(pass.id)).toBeNull();
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  });

  it('refuses a pass of another org', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const actor = await operator(other.id);
    const pass = await kit.pass();
    expect([403, 404]).toContain((await post(actor.session.headers, `/${pass.id}/remove`)).status);
    expect(await removedAt(pass.id)).toBeNull();
  });

  it('is not failed by a rename or branding save', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    await run(kit.env.DB, 'UPDATE orgs SET name = ?, branding = ? WHERE id = ?', [
      'Renamed',
      JSON.stringify({ accent: 'red' }),
      kit.org.id,
    ]);
    expect((await post(actor.session.headers, `/${pass.id}/remove`)).status).toBe(200);
  });

  it('answers 200 to the loser of two racing removes, with one removal', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    const [x, y] = await Promise.all([
      post(actor.session.headers, `/${pass.id}/remove`),
      post(actor.session.headers, `/${pass.id}/remove`),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const n = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM pass_versions WHERE pass_id = ? AND source = 'remove'",
      [pass.id],
    );
    expect(n?.n).toBe(1);
  });
});

describe('delete, rotate and refresh as grants', () => {
  it('rotates the link and refuses a revoked membership', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    expect((await post(actor.session.headers, `/${pass.id}/rotate-link`)).status).toBe(200);
    const after = await first<{ download_token: string; link_generation: number }>(
      kit.env.DB,
      'SELECT download_token, link_generation FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(after?.download_token).not.toBe(pass.downloadToken);
    expect(after?.link_generation).toBe(pass.linkGeneration + 1);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      actor.membershipId,
    ]);
    expect((await post(actor.session.headers, `/${pass.id}/rotate-link`)).status).toBe(403);
  });

  it('soft deletes through a session', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    const response = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}`,
      { method: 'DELETE', headers: { ...actor.session.headers, origin: ORIGIN } },
      kit.env,
    );
    expect(response.status).toBe(200);
    expect(
      (
        await first<{ deleted_at: number | null }>(
          kit.env.DB,
          'SELECT deleted_at FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.deleted_at,
    ).not.toBeNull();
    await assertNoLeakedGrants(kit.env.DB);
  });
});

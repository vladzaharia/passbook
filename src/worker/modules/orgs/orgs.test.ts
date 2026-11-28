import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type ApiKeyFixture,
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { isOrgActive } from './active.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (env) => ({
    ...denyAllStores,
    sessions: createSessionStore(env, clock),
    apiKeys: createApiKeyStore(env, clock),
  }),
  clock,
});
let appEnv: AppEnv;
let f: Fixtures;
let platformAdmin: SessionFixture;
let orgAdmin: SessionFixture;
let apiKey: ApiKeyFixture;
const call = (method: string, path: string, body?: unknown, headers = platformAdmin.headers) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    appEnv,
  );

beforeAll(async () => {
  appEnv = await makeEnv();
  f = fixtures(appEnv, clock);
  const platformUser = await makeUser(f);
  const tenantUser = await makeUser(f);
  platformAdmin = await makeSession(f, { userId: platformUser.id, roles: ['admin', 'user'] });
  orgAdmin = await makeSession(f, { userId: tenantUser.id });
  apiKey = await makeApiKey(f);
});

async function join(orgId: string, userId = orgAdmin.userId) {
  const invitationId = f.ids.id();
  const now = f.clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, '["org_admin"]', f.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, userId, invitationId, '["org_admin"]', now],
  );
}

describe('orgs api', () => {
  it('joins the creator as org_admin in the create batch unless addMe is false', async () => {
    const created = await call('POST', '', { slug: 'with-me', name: 'With me' });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const rows = await all<{ roles: string; accepted_at: number | null }>(
      appEnv.DB,
      `SELECT m.roles AS roles, i.accepted_at AS accepted_at FROM org_memberships m
       JOIN org_invitations i ON i.id = m.invitation_id
       WHERE m.org_id = ? AND m.user_id = ?`,
      [id, platformAdmin.userId],
    );
    expect(rows).toEqual([{ roles: '["org_admin"]', accepted_at: expect.any(Number) }]);
    expect((await call('GET', `/${id}/workspace`)).status).toBe(200);
    const audited = await all<{ detail: string }>(
      appEnv.DB,
      "SELECT detail FROM audit_log WHERE org_id = ? AND action = 'org.create'",
      [id],
    );
    expect(JSON.parse(audited[0]?.detail ?? '{}')).toMatchObject({ addMe: true });

    const apart = await call('POST', '', { slug: 'without-me', name: 'Without me', addMe: false });
    const other = ((await apart.json()) as { id: string }).id;
    expect(await all(appEnv.DB, 'SELECT 1 FROM org_memberships WHERE org_id = ?', [other])).toEqual(
      [],
    );
  });

  it('rejects header-injection and bidi characters in the name', async () => {
    for (const name of ['Acme\r\nBcc: x@y.z', 'Acme\u202Eevil', 'A\u2028B']) {
      expect((await call('POST', '', { slug: 'inj-org', name })).status).toBe(422);
    }
    const ok = await call('POST', '', { slug: 'inj-ok', name: 'Acme' });
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { id: string }).id;
    await join(id);
    expect(
      (await call('PATCH', `/${id}`, { name: 'Acme\r\nBcc: x@y.z' }, orgAdmin.headers)).status,
    ).toBe(422);
  });

  it('requires an admin', async () => {
    await expectProblem(await call('GET', '', undefined, orgAdmin.headers), 403, 'FORBIDDEN');
    expect((await call('GET', '', undefined, {})).status).toBe(401);
    expect((await call('GET', '', undefined, apiKey.headers)).status).toBe(403);
  });

  it('creates, reads, updates and soft-deletes with audit rows', async () => {
    const created = await call('POST', '', {
      slug: 'acme',
      name: 'Acme',
      branding: { accent: '#112233' },
      addMe: false,
    });
    expect(created.status).toBe(201);
    const org = (await created.json()) as { id: string; status: string; branding: object };
    expect(org.status).toBe('active');
    expect(org.branding).toEqual({ accent: '#112233' });

    const provisioning = await call('GET', `/${org.id}`);
    expect(provisioning.status).toBe(200);
    const provisioningBody = await provisioning.json();
    expect(provisioningBody).toEqual({
      id: org.id,
      name: 'Acme',
      slug: 'acme',
      status: 'active',
      personal: false,
      createdAt: expect.any(Number),
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0, members: 0 },
      countsCapped: false,
      plan: { preset: 'standard', label: 'Season Pass' },
    });
    expect(provisioningBody).not.toHaveProperty('branding');
    expect(provisioningBody).not.toHaveProperty('supportEmail');
    expect(provisioningBody).not.toHaveProperty('supportUrl');
    expect(provisioningBody).not.toHaveProperty('support');
    expect(provisioningBody).not.toHaveProperty('defaultIdentityId');
    await expectProblem(await call('GET', `/${org.id}/workspace`), 403, 'FORBIDDEN');
    await join(org.id);
    await expectProblem(
      await call('GET', `/${org.id}`, undefined, orgAdmin.headers),
      403,
      'FORBIDDEN',
    );
    await join(org.id, platformAdmin.userId);
    const workspace = await call('GET', `/${org.id}/workspace`, undefined, orgAdmin.headers);
    expect(workspace.status).toBe(200);
    const got = await workspace.json();
    expect(got).toMatchObject({
      slug: 'acme',
      branding: { accent: '#112233' },
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0, members: 2 },
      countsCapped: false,
    });
    // The plan is a platform directory field: the tenant workspace never carries it.
    expect(got).not.toHaveProperty('plan');

    // A status change travels alone: mixing it with edits would be two commits that can half-apply.
    const mixed = await call('PATCH', `/${org.id}`, { name: 'Acme Inc', status: 'suspended' });
    await expectProblem(mixed, 400, 'ORG_STATUS_ALONE');
    const renamed = await call('PATCH', `/${org.id}`, { name: 'Acme Inc' });
    expect(await renamed.json()).toMatchObject({ name: 'Acme Inc', status: 'active' });
    const stale = await call('PATCH', `/${org.id}`, { status: 'suspended', configRevision: 0 });
    await expectProblem(stale, 409, 'SETTINGS_CHANGED');
    const patched = await call('PATCH', `/${org.id}`, { status: 'suspended' });
    expect(await patched.json()).toMatchObject({ name: 'Acme Inc', status: 'suspended' });

    expect((await call('DELETE', `/${org.id}`)).status).toBe(200);
    await expectProblem(await call('GET', `/${org.id}`), 404, 'ORG_NOT_FOUND');
    expect((await call('GET', `/${org.id}/workspace`, undefined, orgAdmin.headers)).status).toBe(
      403,
    );
    await expectProblem(await call('DELETE', `/${org.id}`), 404, 'ORG_NOT_FOUND');

    const actions = await all<{ action: string; detail: string | null }>(
      env.DB,
      'SELECT action, detail FROM audit_log WHERE target_id = ? ORDER BY id',
      [org.id],
    );
    expect(actions.map((a) => a.action)).toEqual([
      'org.create',
      'org.update',
      'org.suspend',
      'org.close',
    ]);
    expect(JSON.parse(actions[1]?.detail ?? '{}').changes.name).toEqual({
      from: 'Acme',
      to: 'Acme Inc',
    });
  });

  it('rejects duplicate slugs, bad slugs and unknown identities', async () => {
    await call('POST', '', { slug: 'dup-org', name: 'One' });
    const dup = await call('POST', '', { slug: 'dup-org', name: 'Two' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: 'ORG_SLUG_TAKEN' });
    expect((await call('POST', '', { slug: 'Bad Slug', name: 'x' })).status).toBe(422);
    const noIdentity = await call('POST', '', {
      slug: 'no-id',
      name: 'x',
      defaultIdentityId: 'nope',
    });
    expect(await noIdentity.json()).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('masks unknown orgs and does not touch other orgs on update', async () => {
    await expectProblem(
      await call('PATCH', '/missing', { name: 'x' }, orgAdmin.headers),
      403,
      'FORBIDDEN',
    );
    const f = fixtures(appEnv);
    const a = await makeOrg(f);
    const b = await makeOrg(f);
    await join(a.id);
    expect((await call('PATCH', `/${a.id}`, { name: 'Renamed' }, orgAdmin.headers)).status).toBe(
      200,
    );
    const rows = await all<{ id: string; name: string }>(
      env.DB,
      'SELECT id, name FROM orgs WHERE id = ?',
      [b.id],
    );
    expect(rows[0]?.name).toBe('Test Org');
  });

  it('counts only the org own rows and pages with a cursor', async () => {
    const f = fixtures(appEnv);
    const a = await makeOrg(f);
    const b = await makeOrg(f);
    const now = f.clock.now();
    for (const [org, n] of [
      [a.id, 2],
      [b.id, 1],
    ] as const) {
      for (let i = 0; i < n; i++)
        await run(
          env.DB,
          'INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [f.ids.id(), org, 'k', f.ids.id(), f.ids.id(), '[]', now],
        );
    }
    await run(
      env.DB,
      "INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at, revoked_at) VALUES (?, ?, 'r', ?, ?, '[]', ?, ?)",
      [f.ids.id(), a.id, f.ids.id(), f.ids.id(), now, now],
    );
    const listed = (await (await call('GET', '?limit=1')).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBeTruthy();
    const all2 = (await (await call('GET', '?limit=200')).json()) as {
      items: { id: string; counts: { apiKeys: number } }[];
    };
    const aItem = all2.items.find((o) => o.id === a.id);
    expect(aItem).toEqual({
      id: a.id,
      name: a.name,
      slug: a.slug,
      status: 'active',
      personal: false,
      createdAt: expect.any(Number),
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 2, members: 0 },
      countsCapped: false,
      plan: { preset: 'legacy', label: 'Unlimited' },
    });
    for (const field of ['branding', 'support', 'supportEmail', 'supportUrl', 'defaultIdentityId'])
      expect(aItem).not.toHaveProperty(field);
    expect(all2.items.find((o) => o.id === b.id)?.counts.apiKeys).toBe(1);
    const page2 = (await (await call('GET', `?limit=200&cursor=${listed.nextCursor}`)).json()) as {
      items: { id: string }[];
    };
    expect(page2.items.map((o) => o.id)).not.toContain(listed.items[0]?.id);
  });
});

describe('isOrgActive', () => {
  it('is true only while the org is active', async () => {
    const f = fixtures(appEnv);
    const org = await makeOrg(f);
    const ctx = createServiceContext(appEnv);
    expect(await isOrgActive(ctx, org.id)).toBe(true);
    expect((await call('POST', `/${org.id}/status`, { status: 'suspended' })).status).toBe(200);
    expect(await isOrgActive(ctx, org.id)).toBe(false);
    expect((await call('POST', `/${org.id}/status`, { status: 'active' })).status).toBe(200);
    expect(await isOrgActive(ctx, org.id)).toBe(true);
    await call('DELETE', `/${org.id}`);
    expect(await isOrgActive(ctx, org.id)).toBe(false);
    expect(await isOrgActive(ctx, 'missing')).toBe(false);
  });
});

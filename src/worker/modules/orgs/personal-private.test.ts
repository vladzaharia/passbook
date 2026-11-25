import { beforeAll, describe, expect, it } from 'vitest';
import migration from '../../../../migrations/0216_personal_orgs_unlimited.sql?raw';
import {
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
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensurePersonalOrg } from './personal.ts';
import { presetRows } from './repo-entitlements.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (e) => ({
    ...denyAllStores,
    sessions: createSessionStore(e, clock),
    apiKeys: createApiKeyStore(e, clock),
  }),
  clock,
});
let env: AppEnv;
let f: Fixtures;
let other: SessionFixture;
let owner: SessionFixture;
let personalId: string;
let regularId: string;
const ctx = () => createServiceContext(env, { clock });

async function adminSession(name: string) {
  const user = await makeUser(f);
  await run(env.DB, 'UPDATE users SET name = ? WHERE id = ?', [name, user.id]);
  const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
  return { user, session };
}
const call = (as: SessionFixture, method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { ...as.headers, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    },
    env,
  );
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

beforeAll(async () => {
  env = await makeEnv();
  f = fixtures(env, clock);
  other = (await adminSession('Other Admin')).session;
  const { user, session } = await adminSession('Pat Owner');
  owner = session;
  await ensurePersonalOrg(ctx(), {
    userId: user.id,
    sessionId: await sha256Hex(session.cookieValue),
  });
  personalId =
    (
      await first<{ id: string }>(env.DB, 'SELECT id FROM orgs WHERE personal_user_id = ?', [
        user.id,
      ])
    )?.id ?? '';
  regularId = (await makeOrg(f)).id;
});

describe('personal orgs are private to the platform', () => {
  it('leaves personal orgs out of the directory, by list and by search', async () => {
    const res = await call(other, 'GET', '/api/v1/orgs?limit=200');
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((o) => o.id);
    expect(ids).toContain(regularId);
    expect(ids).not.toContain(personalId);
    const found = await call(other, 'GET', '/api/v1/orgs?q=personal');
    expect(
      ((await found.json()) as { items: { id: string }[] }).items.map((o) => o.id),
    ).not.toContain(personalId);
  });

  it('refuses the directory page, status, close, features and plan to another platform admin', async () => {
    const refused = [
      await call(other, 'GET', `/api/v1/orgs/${personalId}`),
      await call(other, 'DELETE', `/api/v1/orgs/${personalId}`),
      await call(other, 'GET', `/api/v1/platform/orgs/${personalId}/entitlements`),
      await call(other, 'PUT', `/api/v1/platform/orgs/${personalId}/entitlements`, {
        expectedRevision: 1,
        preset: 'trial',
        overrides: {},
      }),
      await call(other, 'GET', `/api/v1/orgs/${personalId}/lifecycle`),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('ORG_PERSONAL');
    }
    // Editing it is a tenant action: a non-member is refused there, whatever the body.
    const patch = await call(other, 'PATCH', `/api/v1/orgs/${personalId}`, { status: 'suspended' });
    expect(patch.status).toBe(403);
    expect(
      await first(env.DB, "SELECT 1 AS x FROM orgs WHERE id = ? AND status = 'active'", [
        personalId,
      ]),
    ).not.toBeNull();
  });

  it('still lets an ordinary org be managed', async () => {
    const res = await call(other, 'GET', `/api/v1/orgs/${regularId}`);
    expect(res.status).toBe(200);
    expect(
      (await call(other, 'GET', `/api/v1/platform/orgs/${regularId}/entitlements`)).status,
    ).toBe(200);
  });

  it('leaves the owner their own org, its directory page and workspace included', async () => {
    const page = await call(owner, 'GET', `/api/v1/orgs/${personalId}`);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      personal: true,
      personalOwner: { name: 'Pat Owner' },
    });
    expect((await call(owner, 'GET', `/api/v1/orgs/${personalId}/workspace`)).status).toBe(200);
    const mine = await call(owner, 'GET', '/api/v1/orgs/memberships/me');
    expect(
      ((await mine.json()) as { items: { orgId: string }[] }).items.map((m) => m.orgId),
    ).toEqual([personalId]);
  });

  it('keeps personal orgs out of the closed list and the preset org counts', async () => {
    await run(
      env.DB,
      "UPDATE orgs SET status = 'deleted', closed_at = 1, purge_after = 9999999999999 WHERE id = ?",
      [personalId],
    );
    const closed = await call(other, 'GET', '/api/v1/platform/closed-orgs');
    expect(closed.status).toBe(200);
    expect(
      ((await closed.json()) as { items: { id: string }[] }).items.map((o) => o.id),
    ).not.toContain(personalId);
    await run(
      env.DB,
      "UPDATE orgs SET status = 'active', closed_at = NULL, purge_after = NULL WHERE id = ?",
      [personalId],
    );
    const presets = await call(other, 'GET', '/api/v1/platform/entitlement-presets');
    const unlimited = (
      (await presets.json()) as { presets: { preset: string; orgCount: number }[] }
    ).presets.find((p) => p.preset === 'legacy');
    const total = await first<{ n: number }>(
      env.DB,
      "SELECT count(*) AS n FROM org_entitlements e JOIN orgs o ON o.id = e.org_id WHERE e.preset = 'legacy' AND o.personal_user_id IS NULL",
    );
    expect(unlimited?.orgCount).toBe(total?.n);
  });
});

describe('platform audit', () => {
  it('keeps the events of a personal org and names it by its owner, with no link to manage it', async () => {
    for (const id of [personalId, regularId])
      await run(
        env.DB,
        "INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id) VALUES (1, ?, 'system', 'org.update', 'org', ?)",
        [id, id],
      );
    const res = await call(other, 'GET', '/api/v1/audit/platform?limit=200');
    const items = ((await res.json()) as { items: { orgId: string; orgLabel: string | null }[] })
      .items;
    expect(items.find((e) => e.orgId === personalId)?.orgLabel).toBe('Personal org of Pat Owner');
    expect(items.find((e) => e.orgId === regularId)?.orgLabel).toBeNull();
  });
});

describe('Unlimited', () => {
  it('puts a new personal org on Unlimited', async () => {
    expect(
      await first(env.DB, 'SELECT preset FROM org_entitlements WHERE org_id = ?', [personalId]),
    ).toMatchObject({ preset: 'legacy' });
  });

  it('moves existing personal orgs, and only them, in migration 0216', async () => {
    const { user } = await adminSession('Old Personal');
    const oldId = f.ids.id();
    await run(
      env.DB,
      "INSERT INTO orgs (id, slug, name, created_at, updated_at, personal_user_id) VALUES (?, 'personal-old', 'Old', 1, 1, ?)",
      [oldId, user.id],
    );
    await run(
      env.DB,
      "INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES (?, 'standard', 1)",
      [oldId],
    );
    await run(
      env.DB,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'members', '3', 1)",
      [oldId],
    );
    // An org already on Unlimited keeps its row, revision and overrides.
    await run(
      env.DB,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'members', '9', 1)",
      [personalId],
    );
    const staying = await first<{ preset: string; revision: number; preset_revision: number }>(
      env.DB,
      'SELECT preset, revision, preset_revision FROM org_entitlements WHERE org_id = ?',
      [personalId],
    );
    const regular = await first<{ preset: string; revision: number }>(
      env.DB,
      'SELECT preset, revision FROM org_entitlements WHERE org_id = ?',
      [regularId],
    );
    const statements = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) await run(env.DB, s);
    const moved = await first<{ preset: string; preset_revision: number; revision: number }>(
      env.DB,
      'SELECT preset, preset_revision, revision FROM org_entitlements WHERE org_id = ?',
      [oldId],
    );
    // Below any preset revision: the next apply of Unlimited re-evaluates the org in full.
    expect(moved).toEqual({ preset: 'legacy', preset_revision: 0, revision: 2 });
    expect(
      await first(
        env.DB,
        'SELECT preset, revision, preset_revision FROM org_entitlements WHERE org_id = ?',
        [personalId],
      ),
    ).toEqual(staying);
    expect(
      await all(env.DB, 'SELECT value FROM org_entitlement_overrides WHERE org_id = ?', [
        personalId,
      ]),
    ).toHaveLength(1);
    expect(
      await all(env.DB, 'SELECT key FROM org_entitlement_overrides WHERE org_id = ?', [oldId]),
    ).toEqual([]);
    expect(
      await first(
        env.DB,
        "SELECT detail FROM audit_log WHERE org_id = ? AND action = 'org.entitlements_update'",
        [oldId],
      ),
    ).not.toBeNull();
    expect(
      await first(env.DB, 'SELECT preset, revision FROM org_entitlements WHERE org_id = ?', [
        regularId,
      ]),
    ).toEqual(regular);
  });
});

/** A fresh admin with a personal org of their own. */
async function ownerWithOrg(name: string) {
  const { user, session } = await adminSession(name);
  await ensurePersonalOrg(ctx(), {
    userId: user.id,
    sessionId: await sha256Hex(session.cookieValue),
  });
  const org = await first<{ id: string }>(
    env.DB,
    'SELECT id FROM orgs WHERE personal_user_id = ?',
    [user.id],
  );
  return { user, session, orgId: org?.id ?? '' };
}

describe('the platform emergency stop', () => {
  it('lets another admin suspend; the org is cut off; the owner cannot lift it; a second admin can', async () => {
    const o = await ownerWithOrg('Stopped Owner');
    const key = await makeApiKey(f, { orgId: o.orgId, scopes: ['templates:read'] });
    const before = await app.request('/api/v1/templates', { headers: key.headers }, env);
    expect(before.status).toBe(200);
    const stop = await call(other, 'POST', `/api/v1/orgs/${o.orgId}/status`, {
      status: 'suspended',
    });
    expect(stop.status).toBe(200);
    // A suspended org's key stops at the door (the key store refuses it: 401 today, 403 in other paths).
    expect([401, 403]).toContain(
      (await app.request('/api/v1/templates', { headers: key.headers }, env)).status,
    );
    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE org_id = ? AND action = 'org.suspend'",
      [o.orgId],
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ personal: true, override: true });
    const lift = await call(o.session, 'POST', `/api/v1/orgs/${o.orgId}/status`, {
      status: 'active',
    });
    expect(lift.status).toBe(403);
    expect(await code(lift)).toBe('ORG_PERSONAL');
    const second = (await adminSession('Second Admin')).session;
    expect(
      (await call(second, 'POST', `/api/v1/orgs/${o.orgId}/status`, { status: 'active' })).status,
    ).toBe(200);
    expect((await app.request('/api/v1/templates', { headers: key.headers }, env)).status).toBe(
      200,
    );
  });

  it('does not let the owner close an org another admin suspended, and still records a second suspend', async () => {
    const o = await ownerWithOrg('Closing Owner');
    await call(other, 'POST', `/api/v1/orgs/${o.orgId}/status`, { status: 'suspended' });
    const close = await call(o.session, 'DELETE', `/api/v1/orgs/${o.orgId}`);
    expect(close.status).toBe(403);
    expect(await code(close)).toBe('ORG_PERSONAL');
    expect(await first(env.DB, 'SELECT status FROM orgs WHERE id = ?', [o.orgId])).toMatchObject({
      status: 'suspended',
    });
    // The owner suspends their own, then an admin suspends it again: the owner still cannot lift it.
    const p = await ownerWithOrg('Double Stop');
    await call(p.session, 'POST', `/api/v1/orgs/${p.orgId}/status`, { status: 'suspended' });
    await call(other, 'POST', `/api/v1/orgs/${p.orgId}/status`, { status: 'suspended' });
    const rows = await all<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE org_id = ? AND action = 'org.suspend' ORDER BY id",
      [p.orgId],
    );
    expect(rows.map((r) => JSON.parse(r.detail).override)).toEqual([false, true]);
    const lift = await call(p.session, 'POST', `/api/v1/orgs/${p.orgId}/status`, {
      status: 'active',
    });
    expect(lift.status).toBe(403);
  });

  it('lets the owner suspend and reactivate their own', async () => {
    const o = await ownerWithOrg('Self Stopper');
    expect(
      (await call(o.session, 'POST', `/api/v1/orgs/${o.orgId}/status`, { status: 'suspended' }))
        .status,
    ).toBe(200);
    expect(
      (await call(o.session, 'POST', `/api/v1/orgs/${o.orgId}/status`, { status: 'active' }))
        .status,
    ).toBe(200);
  });

  it("suspends a user's personal org when the user is disabled", async () => {
    const o = await ownerWithOrg('Disabled Owner');
    const res = await call(other, 'PATCH', `/api/v1/users/${o.user.id}`, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(await first(env.DB, 'SELECT status FROM orgs WHERE id = ?', [o.orgId])).toMatchObject({
      status: 'suspended',
    });
  });

  it('refuses the owner a plan or override write too', async () => {
    const o = await ownerWithOrg('Plan Owner');
    const res = await call(o.session, 'PUT', `/api/v1/platform/orgs/${o.orgId}/entitlements`, {
      expectedRevision: 1,
      preset: 'trial',
      overrides: {},
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('ORG_PERSONAL');
  });
});

describe('other platform paths into a personal org', () => {
  it('keeps another admin out of its members, invitations and identity runs; the owner stays in', async () => {
    const o = await ownerWithOrg('Members Owner');
    for (const path of [
      `/api/v1/orgs/${o.orgId}/memberships`,
      `/api/v1/orgs/${o.orgId}/invitations`,
      `/api/v1/identity-runs?orgId=${o.orgId}`,
      `/api/v1/wallet-identities?orgId=${o.orgId}`,
    ]) {
      const res = await call(other, 'GET', path);
      expect([403, 404], path).toContain(res.status);
    }
    expect((await call(o.session, 'GET', `/api/v1/orgs/${o.orgId}/memberships`)).status).toBe(200);
    expect((await call(o.session, 'GET', `/api/v1/identity-runs?orgId=${o.orgId}`)).status).toBe(
      200,
    );
  });

  it('refuses platform metrics for a personal org to anyone but its owner', async () => {
    const o = await ownerWithOrg('Metrics Owner');
    const res = await call(other, 'GET', `/api/v1/metrics/platform/overview?orgId=${o.orgId}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('ORG_PERSONAL');
    expect(
      (await call(o.session, 'GET', `/api/v1/metrics/platform/overview?orgId=${o.orgId}`)).status,
    ).toBe(200);
  });

  it('keeps an org-less platform key from reading its templates', async () => {
    const o = await ownerWithOrg('Template Owner');
    const key = await makeApiKey(f, { orgId: null, kind: 'platform', scopes: ['templates:read'] });
    const res = await app.request(
      `/api/v1/templates?orgId=${o.orgId}`,
      { headers: key.headers },
      env,
    );
    expect([403, 404]).toContain(res.status);
    const ok = await app.request(
      `/api/v1/templates?orgId=${regularId}`,
      { headers: key.headers },
      env,
    );
    expect(ok.status).toBe(200);
  });

  it('names personal orgs for views that show an org by id, and counts the raw preset size', async () => {
    const res = await call(other, 'GET', '/api/v1/platform/personal-org-labels');
    const items = ((await res.json()) as { items: { orgId: string; label: string }[] }).items;
    expect(items.find((i) => i.orgId === personalId)?.label).toBe('Personal org of Pat Owner');
    const legacy = (await presetRows(env.DB)).find((p) => p.preset === 'legacy');
    expect(legacy?.org_count).toBeGreaterThan(legacy?.shown_count ?? 0);
  });
});

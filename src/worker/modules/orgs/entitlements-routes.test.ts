import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeUser } from '../../../../test/helpers/index.ts';
import type {
  OrgEntitlementsDto,
  SetOrgEntitlementsInput,
} from '../../../shared/contracts/entitlement-admin.ts';
import { ENTITLEMENT_KEYS, presetValues } from '../../../shared/contracts/entitlements.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { writeEntitlements } from './repo-entitlements.ts';

const fake = fakeAuth();
let rk: RetentionKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  rk = await retentionKit();
  fake.bindSessions(rk.kit.env.DB, rk.kit.clock);
  fake.bindApiKeys(rk.kit.env, rk.kit.clock);
  app = createApp({ stores: fake.stores, clock: rk.kit.clock });
}, 30_000);

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    rk.kit.env,
  );
const platformPath = (orgId: string) => `/api/v1/platform/orgs/${orgId}/entitlements`;
const orgPath = (orgId: string) => `/api/v1/orgs/${orgId}/entitlements`;

async function member(orgId: string, role: string) {
  const { fx, env, clock } = rk.kit;
  const user = await makeUser(fx);
  const invitationId = fx.ids.id();
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify([role]),
      fx.ids.token(),
      now,
      now + 3_600_000,
      now,
    ],
  );
  await run(
    env.DB,
    'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.ids.id(), orgId, user.id, invitationId, JSON.stringify([role]), now],
  );
  return fake.user(user.id);
}

async function people() {
  const admin = await rk.org(['org_admin']);
  const root = await rk.platform();
  return {
    orgId: admin.orgId,
    admin: fake.user(admin.userId),
    reader: await member(admin.orgId, 'read_only'),
    root: fake.session({ userId: root.userId, roles: ['admin', 'user'] }),
  };
}
type People = Awaited<ReturnType<typeof people>>;

const read = async (p: People): Promise<OrgEntitlementsDto> =>
  (await (await call('GET', platformPath(p.orgId), p.root)).json()) as OrgEntitlementsDto;
const put = (p: People, body: SetOrgEntitlementsInput, headers = p.root) =>
  call('PUT', platformPath(p.orgId), headers, body);
const auditRows = (orgId: string) =>
  all<{ actor_id: string; detail: string; target_id: string }>(
    rk.kit.env.DB,
    "SELECT actor_id, detail, target_id FROM audit_log WHERE action = 'org.entitlements_update' AND org_id = ? ORDER BY id",
    [orgId],
  );

describe('platform read', () => {
  it('lists every feature of the preset, the presets with their org counts, and the revision', async () => {
    const p = await people();
    const res = await call('GET', platformPath(p.orgId), p.root);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as OrgEntitlementsDto;
    expect(body).toMatchObject({ preset: 'legacy', presetLabel: 'Unlimited', revision: 1 });
    expect(body.items.map((i) => i.key)).toEqual(ENTITLEMENT_KEYS);
    expect(body.items.every((i) => i.source === 'preset' && i.note === null)).toBe(true);
    expect(body.presets.map((x) => x.preset)).toEqual([
      'trial',
      'starter',
      'standard',
      'premium',
      'legacy',
    ]);
    expect(body.presets.find((x) => x.preset === 'legacy')?.orgCount).toBeGreaterThan(0);
    expect(body.presets.find((x) => x.preset === 'trial')?.values).toEqual(presetValues('trial'));
  });

  it('refuses an org admin, a key and a signed-out caller; an unknown org is a 404', async () => {
    const p = await people();
    expect((await call('GET', platformPath(p.orgId), p.admin)).status).toBe(403);
    const key = fake.apiKey({ orgId: p.orgId, scopes: ['org:read', 'org:write'] });
    expect((await call('GET', platformPath(p.orgId), key)).status).toBe(403);
    expect((await call('GET', platformPath(p.orgId), {})).status).toBe(401);
    expect((await call('GET', platformPath('nope'), p.root)).status).toBe(404);
  });
});

describe('platform write', () => {
  it('applies a preset, bumps the revision and records one audit row with the impact counts', async () => {
    const p = await people();
    const before = await read(p);
    const res = await put(p, { expectedRevision: before.revision, preset: 'trial', overrides: {} });
    expect(res.status).toBe(200);
    const after = (await res.json()) as OrgEntitlementsDto;
    expect(after).toMatchObject({ preset: 'trial', revision: before.revision + 1 });
    expect(after.items.find((i) => i.key === 'apps')?.value).toBe(0);
    expect(after.items.find((i) => i.key === 'passes.live')?.value).toBe(100);
    const rows = await auditRows(p.orgId);
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]?.detail ?? '{}');
    expect(detail.preset).toEqual({ from: 'legacy', to: 'trial' });
    expect(detail.off).toBeGreaterThan(0);
    expect(detail.changes.apps).toEqual({ from: 1, to: 0 });
    expect(rows[0]?.target_id).toBe(p.orgId);
    // The org's own resolved values moved with it.
    const resolved = await entitlementsOf(rk.kit.ctx, p.orgId);
    expect(resolved.apps).toBe(0);
  });

  it('refuses a stale revision with 409 and writes nothing', async () => {
    const p = await people();
    const before = await read(p);
    expect(
      (await put(p, { expectedRevision: before.revision, preset: 'standard', overrides: {} }))
        .status,
    ).toBe(200);
    const stale = await put(p, {
      expectedRevision: before.revision,
      preset: 'trial',
      overrides: {},
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('ENTITLEMENTS_CHANGED');
    const now = await read(p);
    expect(now.preset).toBe('standard');
    expect(await auditRows(p.orgId)).toHaveLength(1);
  });

  it('aborts the whole batch when the revision moves between the read and the write', async () => {
    const p = await people();
    const before = await read(p);
    const admin = await rk.platform();
    // A save lands first: the grant of the slower caller still carries the old revision.
    expect(
      (await put(p, { expectedRevision: before.revision, preset: 'trial', overrides: {} })).status,
    ).toBe(200);
    await expect(
      writeEntitlements(rk.kit.ctx, {
        orgId: p.orgId,
        admin,
        by: admin.userId,
        expectedRevision: before.revision,
        preset: 'standard',
        presetRevision: 1,
        now: rk.kit.clock.now(),
        remove: [],
        put: [{ key: 'api', value: '"off"', note: null, expiresAt: null }],
        audit: {
          actorType: 'user',
          action: 'org.entitlements_update',
          orgId: p.orgId,
          targetType: 'org',
          targetId: p.orgId,
        },
      }),
    ).rejects.toMatchObject({ code: 'ENTITLEMENTS_CHANGED', status: 409 });
    const after = await read(p);
    expect(after.preset).toBe('trial');
    expect(after.items.find((i) => i.key === 'api')?.source).toBe('preset');
    expect(await auditRows(p.orgId)).toHaveLength(1);
  });

  it('sets, changes and removes overrides, which survive a preset change', async () => {
    const p = await people();
    let state = await read(p);
    // The resolving view reads SQLite's own clock, so the expiry must be ahead of both it and the test clock.
    const expiresAt = Math.max(rk.kit.clock.now(), Date.now()) + 86_400_000;
    const res = await put(p, {
      expectedRevision: state.revision,
      preset: 'trial',
      overrides: {
        webhooks: { value: 1, note: 'Pilot with Northwind', expiresAt },
        'api.keys': { value: 5 },
        connectors: { value: ['csv-url', 'shopify/*'] },
      },
    });
    expect(res.status).toBe(200);
    state = (await res.json()) as OrgEntitlementsDto;
    const hooks = state.items.find((i) => i.key === 'webhooks');
    expect(hooks).toMatchObject({
      value: 1,
      presetValue: 0,
      source: 'override',
      note: 'Pilot with Northwind',
      expiresAt,
    });
    expect(state.items.find((i) => i.key === 'api.keys')).toMatchObject({
      value: 5,
      presetValue: 2,
    });
    const listed = await entitlementsOf(rk.kit.ctx, p.orgId);
    expect(listed.webhooks).toBe(1);
    expect(listed.connectors).toEqual(['csv-url', 'shopify/*']);

    // Same overrides on another preset: they stand.
    const moved = (await (
      await put(p, {
        expectedRevision: state.revision,
        preset: 'standard',
        overrides: {
          webhooks: { value: 1, note: 'Pilot with Northwind', expiresAt },
          'api.keys': { value: 5 },
          connectors: { value: ['csv-url', 'shopify/*'] },
        },
      })
    ).json()) as OrgEntitlementsDto;
    expect(moved.items.find((i) => i.key === 'api.keys')).toMatchObject({
      value: 5,
      presetValue: 10,
      source: 'override',
    });

    // Leaving one out removes it.
    const trimmed = (await (
      await put(p, {
        expectedRevision: moved.revision,
        preset: 'standard',
        overrides: { 'api.keys': { value: 5 } },
      })
    ).json()) as OrgEntitlementsDto;
    expect(trimmed.items.filter((i) => i.source === 'override').map((i) => i.key)).toEqual([
      'api.keys',
    ]);
    const rows = await first<{ n: number }>(
      rk.kit.env.DB,
      'SELECT count(*) AS n FROM org_entitlement_overrides WHERE org_id = ?',
      [p.orgId],
    );
    expect(rows?.n).toBe(1);
    const audit = (await auditRows(p.orgId)).map((r) => JSON.parse(r.detail));
    expect(audit).toHaveLength(3);
    // Legacy had webhooks on and no key limit: the override keeps one and the trial preset caps the other.
    expect(audit[0].changes.webhooks).toMatchObject({
      from: 1,
      to: 1,
      note: 'Pilot with Northwind',
    });
    expect(audit[0].changes['api.keys']).toEqual({ from: null, to: 5 });
    expect(audit[2].changes.webhooks).toMatchObject({ override: 'removed' });
  });

  it('writes nothing when nothing changes', async () => {
    const p = await people();
    const before = await read(p);
    const res = await put(p, {
      expectedRevision: before.revision,
      preset: before.preset ?? 'legacy',
      overrides: {},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as OrgEntitlementsDto).revision).toBe(before.revision);
    expect(await auditRows(p.orgId)).toHaveLength(0);
  });

  it('refuses unknown presets, unknown keys, bad values and a past expiry', async () => {
    const p = await people();
    const { revision } = await read(p);
    const bad = async (body: SetOrgEntitlementsInput, path: string) => {
      const res = await put(p, body);
      expect(res.status, path).toBe(422);
      expect(JSON.stringify(await res.json()), path).toContain(path);
    };
    await bad({ expectedRevision: revision, preset: 'gold', overrides: {} }, 'preset');
    await bad(
      { expectedRevision: revision, preset: 'trial', overrides: { nope: { value: 1 } } },
      'overrides.nope',
    );
    await bad(
      { expectedRevision: revision, preset: 'trial', overrides: { api: { value: 'huge' } } },
      'overrides.api.value',
    );
    await bad(
      { expectedRevision: revision, preset: 'trial', overrides: { apps: { value: 2 } } },
      'overrides.apps.value',
    );
    await bad(
      { expectedRevision: revision, preset: 'trial', overrides: { 'api.keys': { value: -1 } } },
      'overrides.api.keys.value',
    );
    await bad(
      {
        expectedRevision: revision,
        preset: 'trial',
        overrides: { apps: { value: 1, expiresAt: rk.kit.clock.now() - 1 } },
      },
      'overrides.apps.expiresAt',
    );
    expect((await read(p)).revision).toBe(revision);
  });

  it('never lets an org admin, a member, a key or a signed-out caller write', async () => {
    const p = await people();
    const { revision } = await read(p);
    const body = { expectedRevision: revision, preset: 'standard', overrides: {} };
    expect((await put(p, body, p.admin)).status).toBe(403);
    expect((await put(p, body, p.reader)).status).toBe(403);
    const key = fake.apiKey({
      orgId: p.orgId,
      scopes: ['org:write', 'brand:manage', 'api-keys:write'],
    });
    expect([401, 403]).toContain((await put(p, body, key)).status);
    expect((await put(p, body, {})).status).toBe(401);
    const row = await first<{ preset: string; revision: number }>(
      rk.kit.env.DB,
      'SELECT preset, revision FROM org_entitlements WHERE org_id = ?',
      [p.orgId],
    );
    expect(row).toEqual({ preset: 'legacy', revision });
    expect(await auditRows(p.orgId)).toHaveLength(0);
  });
});

describe('org read', () => {
  it('shows an org admin and a reader their own features, without notes, revisions or other presets', async () => {
    const p = await people();
    const state = await read(p);
    await put(p, {
      expectedRevision: state.revision,
      preset: 'trial',
      overrides: { webhooks: { value: 1, note: 'Internal deal 42' } },
    });
    for (const who of [p.admin, p.reader]) {
      const res = await call('GET', orgPath(p.orgId), who);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('Internal deal 42');
      const body = JSON.parse(text);
      expect(body).toMatchObject({ orgId: p.orgId, preset: 'trial', label: 'Trial' });
      // `usage` is counts only: no notes, no revision, no other plans.
      expect(Object.keys(body).sort()).toEqual(['items', 'label', 'orgId', 'preset', 'usage']);
      expect(body.usage.members).toBeGreaterThanOrEqual(2);
      expect(body.usage['passes.live']).toBe(0);
      expect(Object.keys(body.usage).sort()).toEqual([
        'api.keys',
        'connections',
        'members',
        'passes.live',
        'passes.test',
        'scanning.devices',
        'templates',
        'webhooks.endpoints',
      ]);
      expect(body.items).toHaveLength(ENTITLEMENT_KEYS.length);
      expect(body.items.find((i: { key: string }) => i.key === 'webhooks')).toEqual({
        key: 'webhooks',
        value: 1,
        source: 'override',
      });
    }
  });

  it("keeps another org's features out, and a key needs org:read", async () => {
    const p = await people();
    const other = await people();
    expect((await call('GET', orgPath(p.orgId), other.admin)).status).toBe(403);
    expect((await call('GET', orgPath(p.orgId), {})).status).toBe(401);
    const allowed = fake.apiKey({ orgId: p.orgId, scopes: ['org:read'] });
    expect((await call('GET', orgPath(p.orgId), allowed)).status).toBe(200);
    expect((await call('GET', orgPath(other.orgId), allowed)).status).toBe(403);
    const lacking = fake.apiKey({ orgId: p.orgId, scopes: ['passes:read'] });
    expect((await call('GET', orgPath(p.orgId), lacking)).status).toBe(403);
    expect((await call('PUT', orgPath(p.orgId), p.admin, {})).status).toBeGreaterThanOrEqual(404);
  });
});

describe('an org without a features row', () => {
  /** What an old build leaves after 0134: the org exists, its row does not. */
  async function rowless() {
    const p = await people();
    const id = rk.kit.fx.ids.id();
    await run(
      rk.kit.env.DB,
      'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
      [id, `orphan-${id.slice(-12)}`, 'Orphan'],
    );
    return { ...p, orgId: id };
  }

  it('reads as "no features set": nothing on, revision 0, the presets to pick from', async () => {
    const p = await rowless();
    const res = await call('GET', platformPath(p.orgId), p.root);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgEntitlementsDto;
    expect(body).toMatchObject({ preset: null, presetLabel: null, revision: 0, items: [] });
    expect(body.presets.map((x) => x.preset)).toEqual([
      'trial',
      'starter',
      'standard',
      'premium',
      'legacy',
    ]);
    // The guard's read sees nothing: fail closed.
    expect(isEntitled(await entitlementsOf(rk.kit.ctx, p.orgId), 'api', 'read')).toBe(false);
  });

  it('is repaired by a PUT with revision 0: the row, the overrides and the audit commit together', async () => {
    const p = await rowless();
    const res = await put(p, {
      expectedRevision: 0,
      preset: 'standard',
      overrides: { webhooks: { value: 0, note: 'Repaired' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgEntitlementsDto;
    expect(body).toMatchObject({ preset: 'standard', revision: 1 });
    expect(body.items.find((i) => i.key === 'webhooks')).toMatchObject({
      value: 0,
      source: 'override',
    });
    // The guard's read now passes where it failed closed.
    const ent = await entitlementsOf(rk.kit.ctx, p.orgId);
    expect(isEntitled(ent, 'api', 'full')).toBe(true);
    expect(isEntitled(ent, 'webhooks')).toBe(false);
    const rows = await auditRows(p.orgId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({
      created: true,
      preset: { from: null, to: 'standard' },
      version: 1,
    });
  });

  it('refuses a wrong revision for a missing row, and a second create', async () => {
    const p = await rowless();
    const wrong = await put(p, { expectedRevision: 1, preset: 'standard', overrides: {} });
    expect(wrong.status).toBe(409);
    expect((await put(p, { expectedRevision: 0, preset: 'standard', overrides: {} })).status).toBe(
      200,
    );
    const again = await put(p, { expectedRevision: 0, preset: 'trial', overrides: {} });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('ENTITLEMENTS_CHANGED');
    const rows = await all<{ preset: string }>(
      rk.kit.env.DB,
      'SELECT preset FROM org_entitlements WHERE org_id = ?',
      [p.orgId],
    );
    expect(rows).toEqual([{ preset: 'standard' }]);
  });
});

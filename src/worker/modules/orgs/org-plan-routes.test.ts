import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { SetOrgEntitlementsInput } from '../../../shared/contracts/entitlement-admin.ts';
import type { OrgPlanDto } from '../../../shared/contracts/org-plan.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';

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
const planPath = (orgId: string) => `/api/v1/orgs/${orgId}/plan`;

async function setup() {
  const admin = await rk.org(['org_admin']);
  const root = await rk.platform();
  return {
    orgId: admin.orgId,
    admin: fake.user(admin.userId),
    root: fake.session({ userId: root.userId, roles: ['admin', 'user'] }),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const moveTo = async (
  p: Setup,
  preset: string,
  overrides: SetOrgEntitlementsInput['overrides'] = {},
) => {
  const url = `/api/v1/platform/orgs/${p.orgId}/entitlements`;
  const state = (await (await call('GET', url, p.root)).json()) as { revision: number };
  const res = await call('PUT', url, p.root, {
    expectedRevision: state.revision,
    preset,
    overrides,
  });
  expect(res.status).toBe(200);
};
const plan = async (p: Setup): Promise<OrgPlanDto> =>
  (await (await call('GET', planPath(p.orgId), p.admin)).json()) as OrgPlanDto;

describe('GET /orgs/{id}/plan', () => {
  it('lists the limits above zero with use, and the features the plan has', async () => {
    const p = await setup();
    await moveTo(p, 'trial');
    const res = await call('GET', planPath(p.orgId), p.admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as OrgPlanDto;
    expect(body).toMatchObject({ preset: 'trial', label: 'Trial', footer: 'full' });
    expect(body.limits.find((l) => l.key === 'passes.live')).toEqual({
      key: 'passes.live',
      limit: 100,
      used: 0,
    });
    // Trial has no custom domains (limit 0) and no per-day usage counters.
    expect(body.limits.map((l) => l.key)).not.toContain('domains');
    expect(body.limits.find((l) => l.key === 'email.perDay')).toMatchObject({ used: null });
    const keys = body.features.map((f) => f.key);
    expect(keys).toContain('apple');
    expect(keys).toContain('api');
    expect(keys).not.toContain('wallet.google');
    expect(keys).not.toContain('nfc');
  });

  it('shows no limit as null and every feature on the unlimited plan', async () => {
    const p = await setup();
    await moveTo(p, 'legacy');
    const body = await plan(p);
    expect(body.limits.find((l) => l.key === 'members')?.limit).toBeNull();
    expect(body.features.map((f) => f.key)).toEqual(
      expect.arrayContaining(['wallet.google', 'wallet.samsung', 'print', 'nfc', 'api']),
    );
    expect(body.features.find((f) => f.key === 'nfc')?.level).toBe('secure');
    expect(body.footer).toBe('none');
  });

  it('hides a channel PassBook has switched off, as the channel resolver does', async () => {
    const p = await setup();
    await moveTo(p, 'legacy');
    expect((await plan(p)).features.map((f) => f.key)).toContain('print');
    await run(
      rk.kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'false', 'test', 1)",
    );
    clearSettingsCache(rk.kit.env.DB);
    try {
      expect((await plan(p)).features.map((f) => f.key)).not.toContain('print');
    } finally {
      clearSettingsCache(rk.kit.env.DB);
      await run(
        rk.kit.env.DB,
        "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
      );
    }
  });

  it('keeps other orgs out, and a key needs org:read', async () => {
    const p = await setup();
    const other = await setup();
    expect((await call('GET', planPath(p.orgId), other.admin)).status).toBe(403);
    expect((await call('GET', planPath(p.orgId), {})).status).toBe(401);
    const allowed = fake.apiKey({ orgId: p.orgId, scopes: ['org:read'] });
    expect((await call('GET', planPath(p.orgId), allowed)).status).toBe(200);
    const lacking = fake.apiKey({ orgId: p.orgId, scopes: ['passes:read'] });
    expect((await call('GET', planPath(p.orgId), lacking)).status).toBe(403);
  });
});

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allowInvalidRoleNames,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { MetricsOverviewSchema } from '../../../shared/contracts/metrics.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { clearMetricsCache } from './service.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;

beforeAll(async () => {
  base = await makeEnv();
});
beforeEach(() => clearMetricsCache(env.DB));

async function addMember(f: Fixtures, orgId: string, userId: string, role = 'read_only') {
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = f.clock.now();
  const roles = JSON.stringify([role]);
  await run(
    f.env.DB,
    `INSERT INTO org_invitations
     (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, roles, f.ids.token(), now, now + 3_600_000, now, userId],
  );
  await run(
    f.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, roles, now],
  );
  return membershipId;
}

async function setup(mode: 'live' | 'test' = 'live') {
  const clock = new ManualClock(Date.now());
  const f = fixtures(base, clock);
  const a = await makeOrg(f);
  const b = await makeOrg(f);
  const person = await makeUser(f);
  const membershipId = await addMember(f, a.id, person.id);
  const templateA = makeTemplate({ id: `metrics-a-${f.ids.id()}`, orgId: a.id });
  const templateA2 = makeTemplate({ id: `metrics-a2-${f.ids.id()}`, orgId: a.id });
  const templateB = makeTemplate({ id: `metrics-b-${f.ids.id()}`, orgId: b.id });
  const passA = await makePass(f, {
    orgId: a.id,
    template: templateA.resolved,
    holderEmail: 'a@example.test',
  });
  clock.advance(1);
  const passA2 = await makePass(f, { orgId: a.id, template: templateA2.resolved, mode });
  clock.advance(1);
  const passB = await makePass(f, {
    orgId: b.id,
    template: templateB.resolved,
    mode,
    holderEmail: 'b@example.test',
  });
  const headers = fake.user(person.id);
  return {
    f,
    clock,
    a,
    b,
    person,
    membershipId,
    templateA,
    templateB,
    passA,
    passA2,
    passB,
    headers,
  };
}

function overview(query: string, headers: Record<string, string>, requestEnv = base) {
  return app.request(`/api/v1/metrics/overview${query}`, { headers }, requestEnv);
}

describe('tenant metrics authorization', () => {
  it('requires explicit org membership with passes:read, not a platform role or a bearer key', async () => {
    const s = await setup();
    const q = `?orgId=${s.a.id}`;
    expect((await overview('', s.headers)).status).toBe(422);
    expect((await overview(`?templateId=${s.templateA.resolved.id}`, s.headers)).status).toBe(422);
    expect((await overview(q, s.headers)).status).toBe(200);
    expect((await overview(`?orgId=${s.b.id}`, s.headers)).status).toBe(404);
    expect((await overview('?orgId=missing', s.headers)).status).toBe(404);

    const platformOnly = fake.session({ userId: s.person.id, roles: ['admin', 'user'] });
    expect((await overview(`?orgId=${s.b.id}`, platformOnly)).status).toBe(404);
    const noMembership = await makeUser(s.f);
    const unrelatedAdmin = fake.session({ userId: noMembership.id, roles: ['admin', 'user'] });
    expect((await overview(q, unrelatedAdmin)).status).toBe(404);
    const directory = await app.request(
      `/api/v1/metrics/platform/overview${q}`,
      { headers: unrelatedAdmin },
      base,
    );
    expect(directory.status).toBe(200);
    expect(MetricsOverviewSchema.parse(await directory.json()).setup.latestPassId).toBeNull();
    const templateAuthor = await makeUser(s.f);
    await addMember(s.f, s.a.id, templateAuthor.id, 'template_author');
    expect((await overview(q, fake.user(templateAuthor.id))).status).toBe(404);
    const invalidMember = await makeUser(s.f);
    await allowInvalidRoleNames(env.DB);
    await addMember(s.f, s.a.id, invalidMember.id, 'unknown_role');
    expect((await overview(q, fake.user(invalidMember.id))).status).toBe(404);
    expect(
      (await overview(q, fake.apiKey({ orgId: s.a.id, scopes: ['passes:read'] }))).status,
    ).toBe(401);
    expect(
      (await overview(q, fake.apiKey({ orgId: s.b.id, scopes: ['passes:read'] }))).status,
    ).toBe(401);
    expect((await overview(q, fake.apiKey({ orgId: s.a.id, scopes: [] }))).status).toBe(401);
    expect((await overview(q, {})).status).toBe(401);

    const platform = await app.request(
      '/api/v1/metrics/platform/overview',
      { headers: platformOnly },
      base,
    );
    expect(platform.status).toBe(200);
    expect(
      (await app.request('/api/v1/metrics/platform/overview', { headers: s.headers }, base)).status,
    ).toBe(403);
  });

  it('checks membership and stored template ownership before every cached response', async () => {
    const s = await setup();
    const outboxId = s.f.ids.id();
    await run(
      base.DB,
      "INSERT INTO outbox (id, org_id, pass_id, kind, state, created_at) VALUES (?, ?, ?, 'email', 'sent', ?)",
      [outboxId, s.a.id, s.passA.id, s.clock.now()],
    );
    const own = `?orgId=${s.a.id}&templateId=${s.templateA.resolved.id}&range=24h`;
    const foreign = `?orgId=${s.a.id}&templateId=${s.templateB.resolved.id}&range=24h`;
    const missing = `?orgId=${s.a.id}&templateId=missing&range=24h`;
    expect((await overview(foreign, s.headers)).status).toBe(404);
    expect((await overview(missing, s.headers)).status).toBe(404);
    expect((await overview(own, s.headers)).status).toBe(200);

    // A warmed cache must not survive reassignment of the selected template.
    await run(base.DB, 'UPDATE templates SET org_id = ? WHERE id = ?', [
      s.b.id,
      s.templateA.resolved.id,
    ]);
    expect((await overview(own, s.headers)).status).toBe(404);

    const unfiltered = `?orgId=${s.a.id}&range=24h`;
    expect((await overview(unfiltered, s.headers)).status).toBe(200);
    await run(base.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      s.clock.now(),
      s.membershipId,
    ]);
    expect((await overview(unfiltered, s.headers)).status).toBe(404);
  });

  it('allows shared templates without counting passes or deliveries from other organizations', async () => {
    const s = await setup();
    const template = makeTemplate({ id: `metrics-shared-${s.f.ids.id()}` });
    const own = await makePass(s.f, { orgId: s.a.id, template: template.resolved });
    s.clock.advance(1);
    const foreign = await makePass(s.f, { orgId: s.b.id, template: template.resolved });
    for (const [orgId, passId] of [
      [s.a.id, own.id],
      [s.b.id, foreign.id],
    ] as const) {
      await run(
        base.DB,
        "INSERT INTO outbox (id, org_id, pass_id, kind, state, created_at) VALUES (?, ?, ?, 'email', 'sent', ?)",
        [s.f.ids.id(), orgId, passId, s.clock.now()],
      );
    }
    const response = await overview(
      `?orgId=${s.a.id}&templateId=${template.resolved.id}`,
      s.headers,
    );
    expect(response.status).toBe(200);
    const result = MetricsOverviewSchema.parse(await response.json());
    expect(result.totals).toMatchObject({ passes: 1, issued: 1, emails: 1 });
    expect(result.setup).toMatchObject({
      orgs: 1,
      passes: 1,
      passEmailsSent: 1,
      latestPassId: own.id,
    });
    expect(JSON.stringify(result)).not.toContain(foreign.id);
  });

  it('respects live/test selection and denies suspended orgs or disabled users', async () => {
    const s = await setup('test');
    for (const passId of [s.passA.id, s.passA2.id]) {
      await run(
        base.DB,
        "INSERT INTO outbox (id, org_id, pass_id, kind, state, created_at) VALUES (?, ?, ?, 'email', 'sent', ?)",
        [s.f.ids.id(), s.a.id, passId, s.clock.now()],
      );
    }
    const q = `?orgId=${s.a.id}&range=24h`;
    const testHeaders = fake.session({ userId: s.person.id, roles: ['user'], mode: 'test' });
    const live = MetricsOverviewSchema.parse(await (await overview(q, s.headers)).json());
    const test = MetricsOverviewSchema.parse(await (await overview(q, testHeaders)).json());
    expect(live.totals).toMatchObject({ passes: 1, issued: 1 });
    expect(test.totals).toMatchObject({ passes: 1, issued: 1 });
    expect(live.setup).toMatchObject({ passes: 1, passEmailsSent: 1, latestPassId: s.passA.id });
    expect(test.setup).toMatchObject({ passes: 1, passEmailsSent: 1, latestPassId: s.passA2.id });
    const adminTest = fake.session({ userId: s.person.id, roles: ['admin', 'user'], mode: 'test' });
    const platformResponse = await app.request(
      `/api/v1/metrics/platform/overview${q}`,
      { headers: adminTest },
      base,
    );
    const platform = MetricsOverviewSchema.parse(await platformResponse.json());
    expect(platform.totals.passes).toBe(1);
    // Platform directory filters expose counts only and keep the checklist live-only; a cached
    // tenant response for the same org and mode must not be reused.
    expect(platform.setup).toMatchObject({ passes: 1, passEmailsSent: 1, latestPassId: null });
    const testAgain = MetricsOverviewSchema.parse(await (await overview(q, testHeaders)).json());
    expect(testAgain.setup.latestPassId).toBe(s.passA2.id);
    await run(base.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [s.a.id]);
    expect((await overview(q, testHeaders)).status).toBe(404);
    await run(base.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [s.a.id]);
    await run(base.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [s.person.id]);
    expect((await overview(q, s.headers)).status).toBe(404);
  });

  it('allows explicit platform-admin org filters without sharing privileged recent data with tenants', async () => {
    const s = await setup();
    const at = s.clock.now();
    await run(
      base.DB,
      "INSERT INTO outbox (id, org_id, pass_id, kind, state, created_at) VALUES (?, ?, ?, 'email', 'sent', ?)",
      [s.f.ids.id(), s.a.id, s.passA.id, at],
    );
    await run(
      base.DB,
      "INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id) VALUES (?, ?, 'user', 'pass.update', 'pass', ?)",
      [at, s.a.id, s.passA.id],
    );
    const admin = fake.session({ userId: s.person.id, roles: ['admin', 'user'] });
    const platform = async (orgId: string) =>
      app.request(
        `/api/v1/metrics/platform/overview?orgId=${orgId}&range=24h`,
        { headers: admin },
        base,
      );
    const b = MetricsOverviewSchema.parse(await (await platform(s.b.id)).json());
    expect(b.totals).toMatchObject({ passes: 1, issued: 1, holders: 1, emails: 0 });
    expect(b.setup).toMatchObject({
      orgs: 1,
      assignedTemplates: 1,
      passes: 1,
      passEmailsSent: 0,
      latestPassId: null,
    });
    expect((await overview(`?orgId=${s.b.id}`, admin)).status).toBe(404);
    expect(b.recent).toEqual([]);
    expect(b.live).toEqual([]);
    expect(JSON.stringify(b)).not.toContain(s.passB.id);
    const a = MetricsOverviewSchema.parse(await (await platform(s.a.id)).json());
    expect(a.recent).toEqual([]);
    expect(a.live).toEqual([]);
    expect(a.setup.latestPassId).toBeNull();
    expect(JSON.stringify(a)).not.toContain(s.passA.id);
    const templateOnlyResponse = await app.request(
      `/api/v1/metrics/platform/overview?templateId=${s.templateA.resolved.id}&range=24h`,
      { headers: admin },
      base,
    );
    const templateOnly = MetricsOverviewSchema.parse(await templateOnlyResponse.json());
    expect(templateOnly.totals.passes).toBe(1);
    expect(templateOnly.setup.latestPassId).toBeNull();
    expect(templateOnly.recent).toEqual([]);
    const mismatched = await app.request(
      `/api/v1/metrics/platform/overview?orgId=${s.b.id}&templateId=${s.templateA.resolved.id}`,
      { headers: admin },
      base,
    );
    expect(mismatched.status).toBe(404);
    const tenant = MetricsOverviewSchema.parse(
      await (await overview(`?orgId=${s.a.id}&range=24h`, s.headers)).json(),
    );
    expect(tenant.recent.every((entry) => entry.targetId === null)).toBe(true);
    expect(tenant.recent).toContainEqual({
      at,
      action: 'pass.update',
      orgId: s.a.id,
      targetId: null,
    });
  });

  it('filters counts, series, setup and recent activity before aggregation and pagination', async () => {
    const s = await setup();
    const at = s.clock.now();
    for (const [orgId, passId] of [
      [s.a.id, s.passA.id],
      [s.a.id, s.passA2.id],
      [s.b.id, s.passB.id],
      [s.a.id, null],
      // A malformed outbox association may not count another tenant's pass.
      [s.a.id, s.passB.id],
    ] as const) {
      await run(
        base.DB,
        "INSERT INTO outbox (id, org_id, pass_id, kind, state, created_at) VALUES (?, ?, ?, 'email', 'sent', ?)",
        [s.f.ids.id(), orgId, passId, at],
      );
    }
    for (const [orgId, count] of [
      [s.a.id, 1],
      [s.b.id, 2],
    ] as const) {
      const connectionId = s.f.ids.id();
      await run(
        base.DB,
        "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', 'c', ?, ?)",
        [connectionId, orgId, at, at],
      );
      for (let i = 0; i < count; i++) {
        await run(
          base.DB,
          "INSERT INTO connection_runs (id, connection_id, trigger, started_at) VALUES (?, ?, 'schedule', ?)",
          [s.f.ids.id(), connectionId, at],
        );
        await run(
          base.DB,
          "INSERT INTO audit_log (at, org_id, actor_type, action) VALUES (?, ?, 'user', 'auth.sign_in')",
          [at, orgId],
        );
      }
    }
    for (const passId of [s.passA.id, s.passB.id]) {
      const pass = await first<{ identity_id: string }>(
        base.DB,
        'SELECT identity_id FROM passes WHERE id = ?',
        [passId],
      );
      if (!pass) throw new Error('Missing fixture pass');
      const deviceId = s.f.ids.id();
      await run(
        base.DB,
        'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, ?)',
        [deviceId, pass.identity_id, s.f.ids.token(), at],
      );
      await run(
        base.DB,
        'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, ?)',
        [deviceId, pass.identity_id, passId, at],
      );
    }
    await run(
      base.DB,
      `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, detail)
      VALUES (?, ?, 'user', ?, 'pass.update', 'pass', ?, ?)`,
      [at + 1, s.a.id, 'sensitive@example.test', s.passB.id, '{"token":"wlt_secret"}'],
    );
    await run(
      base.DB,
      `INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id)
      VALUES (?, ?, 'user', ?, 'pass', ?)`,
      [at + 2, s.a.id, 'private@example.test', 'https://wallet.test/p/secret-capability'],
    );
    for (let i = 0; i < 12; i++) {
      await run(
        base.DB,
        "INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id) VALUES (?, ?, 'user', 'pass.update', 'pass', ?)",
        [at + 10 + i, s.b.id, s.passB.id],
      );
    }

    const response = await overview(`?orgId=${s.a.id}&range=24h`, s.headers);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const result = MetricsOverviewSchema.parse(JSON.parse(raw));
    expect(result.totals).toMatchObject({
      passes: 2,
      holders: 1,
      devices: 1,
      issued: 2,
      registrations: 1,
      emails: 3,
      syncRuns: 1,
      signIns: 1,
    });
    expect(result.setup).toEqual({
      orgs: 1,
      assignedTemplates: 2,
      passes: 2,
      passEmailsSent: 3,
      latestPassId: s.passA2.id,
      scanners: 0,
    });
    expect(result.recent).toHaveLength(3);
    expect(result.recent.every((entry) => entry.orgId === s.a.id && entry.targetId === null)).toBe(
      true,
    );
    expect(result.recent.some((entry) => entry.action === 'activity')).toBe(true);
    expect(raw).not.toContain(s.b.id);
    expect(raw).not.toContain(s.passB.id);
    expect(raw).not.toContain('example.test');
    expect(raw).not.toContain('wlt_secret');
    expect(raw).not.toContain('secret-capability');

    const filtered = MetricsOverviewSchema.parse(
      await (
        await overview(
          `?orgId=${s.a.id}&templateId=${s.templateA.resolved.id}&range=24h`,
          s.headers,
        )
      ).json(),
    );
    expect(filtered.totals).toMatchObject({
      passes: 1,
      holders: 1,
      devices: 1,
      issued: 1,
      registrations: 1,
      emails: 1,
      syncRuns: 0,
      signIns: 0,
    });
    expect(filtered.setup).toEqual({
      orgs: 1,
      assignedTemplates: 1,
      passes: 1,
      passEmailsSent: 1,
      latestPassId: s.passA.id,
      scanners: 0,
    });
    expect(filtered.recent).toEqual([]);
  });

  it('does not query Analytics Engine until the org and template are authorized', async () => {
    const s = await setup();
    const calls: AnalyticsSQLQuery[] = [];
    const analytics = {
      query: async (query: AnalyticsSQLQuery) => {
        calls.push(query);
        return { data: [] };
      },
    };
    const withAnalytics = { ...base, ANALYTICS_SQL: analytics } as unknown as AppEnv;
    expect((await overview(`?orgId=${s.b.id}`, s.headers, withAnalytics)).status).toBe(404);
    expect(
      (
        await overview(
          `?orgId=${s.a.id}&templateId=${s.templateB.resolved.id}`,
          s.headers,
          withAnalytics,
        )
      ).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
    expect(
      (
        await overview(
          `?orgId=${s.a.id}&templateId=${s.templateA.resolved.id}`,
          s.headers,
          withAnalytics,
        )
      ).status,
    ).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('blob2 = $orgId');
    expect(calls[0]?.query).toContain('blob3 = $templateId');
    expect(calls[0]?.params).toMatchObject({ orgId: s.a.id, templateId: s.templateA.resolved.id });
  });
});

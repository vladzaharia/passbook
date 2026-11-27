import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makePass, makeTemplate, setLimit } from '../../../../test/helpers/index.ts';
import {
  ResolvedSchema,
  WorkbenchContextsSchema,
  WorkbenchSummarySchema,
} from '../../../shared/contracts/workbench-read.ts';
import { run } from '../../platform/db.ts';
import { workbenchKit } from './workbench-read-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => t.unstub());

const get = (path: string, headers: Record<string, string>) => t.call('GET', path, headers);

/** The developer is a member of a new org with `roles`. */
async function joinOrg(userId: string, roles: string[], over: { name?: string } = {}) {
  const org = await makeOrg(t.kit.f, over);
  const now = t.kit.clock.now();
  const invitationId = t.kit.f.ids.id();
  await run(
    t.kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      org.id,
      'x@example.com',
      JSON.stringify(roles),
      t.kit.f.ids.token(),
      now,
      now + 1e6,
      now,
    ],
  );
  await run(
    t.kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [t.kit.f.ids.id(), org.id, userId, invitationId, JSON.stringify(roles), now],
  );
  return org;
}

describe('GET /workbench/contexts', () => {
  it('lists the sandbox and the organizations where Test is on, with the tools each role reads', async () => {
    const s = await t.sandbox();
    const full = await joinOrg(s.user.id, ['org_admin'], { name: 'Full' });
    const ro = await joinOrg(s.user.id, ['template_author'], { name: 'Author' });
    const off = await joinOrg(s.user.id, ['org_admin'], { name: 'No test' });
    await setLimit(t.kit.env.DB, off.id, 'passes.test', 0);

    const [status, body] = await get('/workbench/contexts', s.session.headers);
    expect(status).toBe(200);
    const ctxs = WorkbenchContextsSchema.parse(body);
    expect(ctxs.sandbox).toMatchObject({
      orgId: s.orgId,
      closed: false,
      timeZone: 'America/Los_Angeles',
    });
    // An org's own zone setting is what its context carries.
    expect(ctxs.orgs.every((o) => o.timeZone === 'America/Los_Angeles')).toBe(true);
    expect(ctxs.orgs.map((o) => o.orgId).sort()).toEqual([full.id, ro.id].sort());
    expect(ctxs.orgs.find((o) => o.orgId === full.id)?.tools).toContain('events');
    const author = ctxs.orgs.find((o) => o.orgId === ro.id)?.tools;
    expect(author).toContain('design');
    expect(author).not.toContain('passes');
    expect(author).not.toContain('events');
  });

  it('leaves out an organization whose plan has no api level; the sandbox stays', async () => {
    const s = await t.sandbox();
    const off = await joinOrg(s.user.id, ['org_admin'], { name: 'No API' });
    const on = await joinOrg(s.user.id, ['org_admin'], { name: 'API' });
    await t.kit.env.DB.prepare(
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'api', '\"off\"', 1)",
    )
      .bind(off.id)
      .run();
    const ctxs = WorkbenchContextsSchema.parse(
      (await get('/workbench/contexts', s.session.headers))[1],
    );
    expect(ctxs.sandbox).toMatchObject({ orgId: s.orgId });
    expect(ctxs.orgs.map((o) => o.orgId)).toEqual([on.id]);
  });
});

describe('GET /workbench/summary', () => {
  it('counts errors, failed deliveries, emails and expiring keys newer than the seen marks', async () => {
    const s = await t.sandbox();
    await t.call('GET', '/passes/00000000-0000-4000-8000-000000000000', s.key);
    await t.call('GET', '/passes/00000000-0000-4000-8000-000000000001', s.key);
    await t.settle();
    const first = WorkbenchSummarySchema.parse(
      (await get('/workbench/summary', s.session.headers))[1],
    );
    expect(first.quickstart).toEqual({ done: 2, total: 5 });
    expect(first.errors).toBe(2);
    expect(first.quotas?.keys.used).toBeGreaterThan(0);
    expect(first.keysExpiring).toBe(0);
    expect(first.failedDeliveries).toBe(0);
    // A mark in the future clears the count; a failed load that sends none does not.
    const seen = (
      await get(`/workbench/summary?since[logs]=${t.kit.clock.now() + 60_000}`, s.session.headers)
    )[1];
    expect(seen.errors).toBe(0);
    expect(seen.quotas).not.toBeNull();
  });

  it('has no quickstart or quotas for an organization, and refuses one that is not the caller’s', async () => {
    const s = await t.sandbox();
    const org = await joinOrg(s.user.id, ['org_admin']);
    const other = await makeOrg(t.kit.f, {});
    const [status, body] = await get(`/workbench/summary?orgId=${org.id}`, s.session.headers);
    expect(status).toBe(200);
    expect(body).toMatchObject({ quickstart: null, quotas: null });
    await expectProblem(
      await t.app.request(
        `https://wallet.test/api/v1/workbench/summary?orgId=${other.id}`,
        { headers: s.session.headers },
        t.kit.env,
      ),
      404,
      'WORKBENCH_CONTEXT_NOT_FOUND',
    );
  });
});

describe('GET /resolve', () => {
  it('names every kind of Test object, and Live as live', async () => {
    const s = await t.sandbox();
    const { endpointId, passes } = await t.eventsFor(s, ['8a1b2c3d4e5f6a7b-SEA']);
    const resolve = async (id: string, orgId?: string) =>
      get(`/resolve?id=${id}${orgId ? `&orgId=${orgId}` : ''}`, s.session.headers);
    const kind = async (id: string) =>
      ResolvedSchema.parse((await resolve(id))[1]) as { kind: string; id: string; href: string };

    expect(await kind(s.orgId)).toMatchObject({
      kind: 'sandbox',
      id: s.orgId,
      href: `/workbench/o/${s.orgId}`,
    });
    expect(await kind('8a1b2c3d4e5f6a7b-SEA')).toMatchObject({ kind: 'request' });
    expect(await kind(passes[0] as string)).toMatchObject({
      kind: 'pass',
      href: `/workbench/o/${s.orgId}/passes#${passes[0]}`,
    });
    expect(await kind(s.templateId)).toMatchObject({
      kind: 'template',
      href: `/workbench/o/${s.orgId}/design/${s.templateId}`,
    });
    expect(await kind(endpointId)).toMatchObject({
      kind: 'endpoint',
      href: `/workbench/o/${s.orgId}/events?tab=endpoints#${endpointId}`,
    });
    const keyRow = await t.kit.env.DB.prepare(
      "SELECT id FROM api_keys WHERE org_id = ? AND mode = 'test' LIMIT 1",
    )
      .bind(s.orgId)
      .first<{ id: string }>();
    expect(await kind(keyRow?.id as string)).toMatchObject({
      kind: 'key',
      href: `/workbench/o/${s.orgId}/keys#${keyRow?.id}`,
    });
    const feed = (await get('/events', s.key))[1];
    expect(await kind(feed.items[0].id)).toMatchObject({
      kind: 'event',
      href: `/workbench/o/${s.orgId}/events#${feed.items[0].id}`,
    });
    const rows = await t.kit.env.DB.prepare(
      'SELECT id FROM webhook_captures WHERE org_id = ? LIMIT 1',
    )
      .bind(s.orgId)
      .first<{ id: string }>();
    expect(await kind(rows?.id as string)).toMatchObject({ kind: 'capture' });
    expect((await kind(rows?.id as string)).href).toMatch(
      new RegExp(`^/workbench/o/${s.orgId}/events\\?capture=${rows?.id}#`),
    );
    const attempt = await t.kit.env.DB.prepare(
      'SELECT id FROM webhook_attempts WHERE org_id = ? LIMIT 1',
    )
      .bind(s.orgId)
      .first<{ id: string }>();
    if (attempt) expect(await kind(attempt.id)).toMatchObject({ kind: 'delivery' });
    await expectProblem(
      await t.app.request(
        'https://wallet.test/api/v1/resolve?id=00000000-0000-4000-8000-0000000000ff',
        { headers: s.session.headers },
        t.kit.env,
      ),
      404,
      'RESOLVE_NOT_FOUND',
    );

    // A Live pass of an organization: found only in that context, and answered as Live.
    const org = await joinOrg(s.user.id, ['org_admin']);
    const template = makeTemplate({ id: t.kit.f.ids.id(), orgId: org.id });
    const live = await makePass(t.kit.f, {
      orgId: org.id,
      template: template.resolved,
      registry: template.registry,
      mode: 'live',
    });
    const asLive = ResolvedSchema.parse((await resolve(live.id, org.id))[1]);
    expect(asLive).toMatchObject({ kind: 'live', href: `/admin/o/${org.id}/passes/${live.id}` });
    await expectProblem(
      await t.app.request(
        `https://wallet.test/api/v1/resolve?id=${live.id}`,
        { headers: s.session.headers },
        t.kit.env,
      ),
      404,
      'RESOLVE_NOT_FOUND',
    );
  });
});

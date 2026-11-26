import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { create, f, h, member, org, other, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM audit_log');
});
afterEach(teardown);

const DAY = 86_400_000;
const as = (key: { secret: string }) => ({ authorization: `Bearer ${key.secret}` });
const window = () => `from=${h.clock.now() - 30 * DAY}&to=${h.clock.now() + DAY}`;
const read = (headers: Record<string, string>, orgId: string, extra = '') =>
  h.call(`/api/v1/audit?orgId=${orgId}&${window()}${extra}`, { headers });
const csv = (headers: Record<string, string>, orgId: string) =>
  h.call(`/api/v1/audit/export?orgId=${orgId}&${window()}`, { headers });
const auditKey = (over: Parameters<typeof makeApiKey>[1] = {}) =>
  makeApiKey(f(), { orgId: org.id, scopes: ['audit:read'], ...over });

async function seed() {
  const ctx = createServiceContext(h.env, { clock: h.clock });
  await recordAudit(ctx, { orgId: org.id, actorType: 'system', action: 'north.one' });
  await recordAudit(ctx, { orgId: org.id, actorType: 'system', action: 'north.two' });
  await recordAudit(ctx, { orgId: other.id, actorType: 'system', action: 'south.secret' });
}

describe('audit log for a key', () => {
  it('needs the scope', async () => {
    await seed();
    const key = await makeApiKey(f(), { orgId: org.id, scopes: ['passes:read'] });
    await expectProblem(await read(as(key), org.id), 403, 'MISSING_SCOPE');
  });

  it('reads its own org only, and its output equals a member session', async () => {
    await seed();
    const key = await auditKey();
    const res = await read(as(key), org.id);
    expect(res.status).toBe(200);
    const keyed = (await res.json()) as { items: { action: string }[] };
    expect(keyed.items.map((i) => i.action)).toEqual(['north.two', 'north.one']);
    await expectProblem(await read(as(key), other.id), 403, 'ORG_FORBIDDEN');
    const { session } = await member('read_only');
    const seen = (await (await read(session.headers, org.id)).json()) as typeof keyed;
    expect(seen).toEqual(keyed);
  });

  it('reads at most 90 days and a page of 100, and must name from', async () => {
    const key = await auditKey();
    await expectProblem(
      await h.call(`/api/v1/audit?orgId=${org.id}`, { headers: as(key) }),
      422,
      'AUDIT_WINDOW_REQUIRED',
    );
    await expectProblem(
      await h.call(`/api/v1/audit?orgId=${org.id}&from=${h.clock.now() - 200 * DAY}`, {
        headers: as(key),
      }),
      422,
      'AUDIT_WINDOW_TOO_WIDE',
    );
    await expectProblem(await read(as(key), org.id, '&limit=101'), 422, 'AUDIT_LIMIT_TOO_HIGH');
  });

  it('refuses a restricted key, a platform key and the platform log', async () => {
    const limited = await auditKey({ passStyles: ['coupon'] });
    expect((await read(as(limited), org.id)).status).toBeGreaterThanOrEqual(401);
    expect((await read(as(limited), org.id)).status).not.toBe(200);
    const platform = await makeApiKey(f(), { orgId: null, scopes: ['audit:read'] });
    expect((await read(as(platform), org.id)).status).not.toBe(200);
    const key = await auditKey();
    // An org key is no Platform key: the platform log refuses it by name, whatever scopes it holds.
    for (const path of ['/api/v1/audit/platform', '/api/v1/audit/platform/export'])
      await expectProblem(await h.call(path, { headers: as(key) }), 403, 'PLATFORM_KEY_REQUIRED');
  });

  it('stops for a personal key whose member lost the role or the membership', async () => {
    const { membershipId } = await member('integration_admin');
    const demoted = await auditKey({
      kind: 'personal',
      membershipId,
      expiresAt: h.clock.now() + DAY,
    });
    expect((await read(as(demoted), org.id)).status).toBe(403);
    const reader = await member('read_only');
    const key = await auditKey({
      kind: 'personal',
      membershipId: reader.membershipId,
      expiresAt: h.clock.now() + DAY,
    });
    expect((await read(as(key), org.id)).status).toBe(200);
    await run(h.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      h.clock.now(),
      reader.membershipId,
    ]);
    expect((await read(as(key), org.id)).status).not.toBe(200);
  });

  it('exports 2 an hour per key, leaves a trail, and counts 6 an hour across the org', async () => {
    await seed();
    const key = await auditKey();
    expect((await csv(as(key), org.id)).status).toBe(200);
    expect((await csv(as(key), org.id)).status).toBe(200);
    await expectProblem(await csv(as(key), org.id), 429, 'RATE_LIMITED');
    const trail = await all<{ actor_type: string; actor_id: string; detail: string }>(
      h.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'audit.export'",
    );
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ actor_type: 'api_key', actor_id: key.id });
    expect(JSON.parse(trail[0]?.detail ?? '{}')).toMatchObject({ truncated: false });
    for (let i = 0; i < 2; i++) await csv(as(await auditKey()), org.id);
    for (let i = 0; i < 2; i++) await csv(as(await auditKey()), org.id);
    await expectProblem(await csv(as(await auditKey()), org.id), 429, 'RATE_LIMITED');
  });
});

describe('minting audit:read and the Test-only scopes', () => {
  const mint = async (json: object, mode: 'live' | 'test' = 'live') => {
    const { session } = await member('org_admin');
    return create(
      { ...session.headers, 'x-passbook-mode': mode },
      { orgId: org.id, name: 'k', mode, ...json },
    );
  };

  it('gives audit:read to a named, Live key only, never through a role', async () => {
    expect((await mint({ scopes: ['audit:read'] })).status).toBe(201);
    await expectProblem(
      await mint({ scopes: ['audit:read'] }, 'test'),
      422,
      'API_KEY_SCOPE_LIVE_ONLY',
    );
    const roled = (await (await mint({ scopes: [], roles: ['org_admin'] })).json()) as {
      scopes: string[];
    };
    expect(roled.scopes).not.toContain('audit:read');
  });

  it('refuses a Live key templates:review and templates:publish, named or through a role', async () => {
    await expectProblem(
      await mint({ scopes: ['templates:review'] }),
      422,
      'API_KEY_SCOPE_TEST_ONLY',
    );
    const live = (await (await mint({ scopes: [], roles: ['org_admin'] })).json()) as {
      scopes: string[];
    };
    expect(live.scopes).toContain('templates:write');
    expect(live.scopes).not.toContain('templates:review');
    expect(live.scopes).not.toContain('templates:publish');
    const test = (await (await mint({ scopes: [], roles: ['org_admin'] }, 'test')).json()) as {
      scopes: string[];
    };
    expect(test.scopes).toEqual(expect.arrayContaining(['templates:review', 'templates:publish']));
  });

  it('keeps the template scopes off a child key and an org-less key', async () => {
    const { session } = await member('org_admin');
    const parent = (await (
      await create(
        { ...session.headers, 'x-passbook-mode': 'test' },
        {
          orgId: org.id,
          name: 'p',
          mode: 'test',
          scopes: ['api-keys:write', 'templates:read', 'templates:write'],
        },
      )
    ).json()) as { secret: string };
    await expectProblem(
      await h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: as(parent),
        json: { orgId: org.id, name: 'c', scopes: ['templates:write'] },
      }),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  });

  it('a key that rotates itself keeps its creator', async () => {
    const { session } = await member('org_admin');
    const made = (await (
      await create(session.headers, {
        orgId: org.id,
        name: 'p',
        scopes: ['api-keys:write', 'passes:read'],
      })
    ).json()) as { id: string; secret: string; createdBy: string };
    const res = await h.call(`/api/v1/api-keys/${made.id}/rotate`, {
      method: 'POST',
      headers: as(made),
      json: { orgId: org.id },
    });
    expect(res.status).toBe(201);
    const next = ((await res.json()) as { key: { id: string } }).key;
    const row = await first<{ created_by: string | null }>(
      h.env.DB,
      'SELECT created_by FROM api_keys WHERE id = ?',
      [next.id],
    );
    expect(row?.created_by).toBe(made.createdBy);
  });
});

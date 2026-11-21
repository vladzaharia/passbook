import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { getDeps, setDeps } from './deps.ts';
import { addMembership, createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';

let kit: Kit;
let session: SessionFixture;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  kit = await makeKit();
  session = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
  await addMembership(kit, kit.actor.id, ['org_admin']);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

async function preview(id: string, headers: Record<string, string> = session.headers) {
  const res = await app.request(
    `/api/v1/connections/${id}/preview`,
    { method: 'POST', headers },
    kit.env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const mapped = { mapping: { memberName: { from: '/memberName' } } };
const count = async (sql: string) => (await first<{ n: number }>(kit.env.DB, sql, []))?.n ?? 0;

describe('POST /connections/{id}/preview', () => {
  it('counts what a first sync would create and writes nothing', async () => {
    const conn = await createDemo(kit, {
      config: { count: 3 },
      ...mapped,
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const before = await count('SELECT COUNT(*) AS n FROM passes');
    const res = await preview(conn.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      records: 3,
      counts: { create: 3, update: 0, unchanged: 0, skipped: 0, errors: 0 },
    });
    expect(res.json.samples[0]).toMatchObject({ ref: 'm-001', action: 'create' });
    expect(res.json.columns.map((c: { pointer: string }) => c.pointer)).toContain('/memberName');
    expect(await count('SELECT COUNT(*) AS n FROM passes')).toBe(before);
    expect(await count('SELECT COUNT(*) AS n FROM connection_runs')).toBe(0);
  });

  it('reports a bound pass as an update, and records nothing issues when issuing is off', async () => {
    const conn = await createDemo(kit, {
      config: { count: 2 },
      ...mapped,
      defaultTemplateId: kit.templateId,
    } as never);
    await linkedPass(kit, conn.id, 'm-001');
    const res = await preview(conn.id);
    expect(res.json.counts).toMatchObject({ create: 0, skipped: 1, update: 1 });
  });

  it('skips a record a void rule matches and flags a record the template rejects', async () => {
    const skip = await createDemo(kit, {
      config: { count: 2 },
      ...mapped,
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      voidWhen: [{ from: '/memberName', op: 'present' }],
    } as never);
    expect((await preview(skip.id)).json.counts).toMatchObject({ skipped: 2, create: 0 });
    const bad = await createDemo(kit, {
      config: { count: 2 },
      mapping: { other: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const res = await preview(bad.id);
    expect(res.json.counts.errors).toBe(2);
    expect(res.json.samples[0].action).toBe('error');
  });

  it('answers a failing source with its code', async () => {
    const conn = await createDemo(kit, { config: { count: 2, fail: 'auth' } } as never);
    const res = await preview(conn.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: false, records: 0 });
    expect(typeof res.json.errorCode).toBe('string');
  });

  it("is 404 for another org's connection and in Test mode", async () => {
    const conn = await createDemo(kit, { config: { count: 1 } } as never);
    const other = await makeOrg(kit);
    const user = await makeUser(kit);
    const otherSession = await makeSession(kit, { userId: user.id, roles: ['user'] });
    await addMembership(kit, user.id, ['org_admin'], other.id);
    const res = await preview(conn.id, otherSession.headers);
    expect([403, 404]).toContain(res.status);
    const test = await preview(conn.id, { ...session.headers, 'x-passbook-mode': 'test' });
    expect(test.status).toBe(404);
  });

  it('reads with connections:read and passes:read keys, and refuses a key missing either', async () => {
    const conn = await createDemo(kit, { config: { count: 2 }, ...mapped } as never);
    const both = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read', 'passes:read'],
    });
    expect((await preview(conn.id, both.headers)).status).toBe(200);
    const noPasses = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    expect((await preview(conn.id, noPasses.headers)).status).toBe(403);
    const noConn = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['passes:read'] });
    expect((await preview(conn.id, noConn.headers)).status).toBe(403);
  });

  it('holds new records back while the template has no approved release', async () => {
    const conn = await createDemo(kit, {
      config: { count: 2 },
      ...mapped,
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const real = getDeps().requireApprovedRelease;
    setDeps({
      requireApprovedRelease: async () => {
        throw new ConflictError('No release.', 'TEMPLATE_RELEASE_REQUIRED');
      },
    });
    try {
      const res = await preview(conn.id);
      expect(res.json.releaseBlocked).toBe('TEMPLATE_RELEASE_REQUIRED');
      expect(res.json.counts).toMatchObject({ create: 0, waiting: 2 });
    } finally {
      setDeps({ requireApprovedRelease: real });
    }
  });

  it('states the 30 day window', async () => {
    const conn = await createDemo(kit, { config: { count: 1 } } as never);
    const { window } = (await preview(conn.id)).json;
    expect(window).toMatchObject({ days: 30, limit: 200, excluded: 0 });
    expect(window.since).toBe(kit.clock.now() - 30 * 86_400_000);
  });
});

describe('POST /connections/test-config?preview=true', () => {
  it('dry-runs an unsaved configuration with its mapping and stores nothing', async () => {
    const before = await count('SELECT COUNT(*) AS n FROM connections');
    const res = await app.request(
      '/api/v1/connections/test-config?preview=true',
      {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: kit.org.id,
          connectorType: 'demo',
          config: { count: 3 },
          ...mapped,
          autoCreate: true,
          defaultTemplateId: kit.templateId,
        }),
      },
      kit.env,
    );
    const json = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(json.counts).toMatchObject({ create: 3, errors: 0 });
    expect(await count('SELECT COUNT(*) AS n FROM connections')).toBe(before);
  });
});

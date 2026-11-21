import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
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
});

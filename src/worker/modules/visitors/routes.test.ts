import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { accessTemplate, grantOf, makeDoor } from '../scan/access-test-fixtures.ts';
import { HOUR, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { ORIGIN } from '../scan/test-kit.ts';

let tpl: string;
let call: (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) => Promise<Response>;
let fake: TenantTestAuth;

beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate();
  fake = await setupTenantTestAuth(kit);
  const app = createApp({ stores: fake.stores, clock: kit.clock });
  call = (method, path, headers, body) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          method,
          headers: { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        kit.env,
      ),
    );
});

const list = (orgId: string) => {
  const start = kit.clock.now() - 2 * HOUR;
  return `/visitors?orgId=${orgId}&tab=today&dayStart=${start}&dayEnd=${start + 24 * HOUR}`;
};

async function visit() {
  const pass = await kit.scanPass(tpl, { plan: 'guest', memberName: 'Leo Park' });
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO visitors (id, org_id, mode, pass_id, name, host_name, host_email, window_from, window_until, created_at)
     VALUES (?, ?, 'live', ?, 'Leo Park', 'Ana Ruiz', 'ana@host.test', ?, ?, ?)`,
    [id, kit.org.id, pass.id, now - HOUR, now + 8 * HOUR, now],
  );
  return { id, pass };
}

describe('visitors API, by key or session', () => {
  it('lists for a key with passes:read, and refuses no credential and another org', async () => {
    const v = await visit();
    const read = await fake.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const res = await call('GET', list(kit.org.id), read);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; hostName: string }[] };
    expect(body.items.find((i) => i.id === v.id)).toMatchObject({ hostName: 'Ana Ruiz' });
    expect((await call('GET', list(kit.org.id), {})).status).toBe(401);
    const other = await makeOrg(kit.fx);
    const stranger = await fake.apiKey({ orgId: other.id, scopes: ['passes:read'] });
    expect((await call('GET', list(kit.org.id), stranger)).status).toBe(403);
  });

  it('works for a console session too', async () => {
    const res = await call('GET', list(kit.org.id), fake.admin());
    expect(res.status).toBe(200);
  });

  it('checks a visitor out and sends the host email again only with passes:write', async () => {
    const door = await makeDoor([tpl]);
    const v = await visit();
    await grantOf(door.headers, v.pass);
    const read = await fake.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const write = await fake.apiKey({ orgId: kit.org.id, scopes: ['passes:read', 'passes:write'] });
    const out = `/visitors/${v.id}/check-out?orgId=${kit.org.id}`;
    expect((await call('POST', out, read)).status).toBe(403);
    const res = await call('POST', out, write);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: v.id, status: 'out' });
    expect((await call('POST', out, write)).status).toBe(409);
  });

  it('offboards by email on a dry run with passes:write', async () => {
    const write = await fake.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const res = await call('POST', `/offboard?orgId=${kit.org.id}`, write, {
      holderEmail: 'nobody@example.test',
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, holders: 0, passes: 0, tags: 0 });
  });
});

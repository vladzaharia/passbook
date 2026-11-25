import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { ACCESS, accessTemplate } from '../scan/access-test-fixtures.ts';
import { kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { ORIGIN } from '../scan/test-kit.ts';

let call: (path: string, headers: Record<string, string>, body?: unknown) => Promise<Response>;
let fake: TenantTestAuth;
let tpl: string;

beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate(ACCESS);
  fake = await setupTenantTestAuth(kit);
  const app = createApp({ stores: fake.stores, clock: kit.clock });
  call = (path, headers, body) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        kit.env,
      ),
    );
});

const dry = (email: string) => ({ holderEmail: email, dryRun: true });

describe('POST /offboard, by key or session', () => {
  it('answers a dry run with passes:write, and counts only this org', async () => {
    await kit.scanPass(tpl, { plan: 'guest' }, { holderEmail: 'route-leaver@example.test' });
    const write = await fake.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const res = await call(
      `/offboard?orgId=${kit.org.id}`,
      write,
      dry('route-leaver@example.test'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, holders: 1, passes: 1, tags: 0, more: false });
    const none = await call(`/offboard?orgId=${kit.org.id}`, write, dry('nobody@example.test'));
    expect(await none.json()).toEqual({
      dryRun: true,
      holders: 0,
      passes: 0,
      tags: 0,
      more: false,
    });
  });

  it('refuses a read-only key, no credential and a key of another org', async () => {
    const read = await fake.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    expect((await call(`/offboard?orgId=${kit.org.id}`, read, dry('x@example.test'))).status).toBe(
      403,
    );
    expect((await call(`/offboard?orgId=${kit.org.id}`, {}, dry('x@example.test'))).status).toBe(
      401,
    );
    const other = await makeOrg(kit.fx);
    const stranger = await fake.apiKey({ orgId: other.id, scopes: ['passes:write'] });
    expect(
      (await call(`/offboard?orgId=${kit.org.id}`, stranger, dry('x@example.test'))).status,
    ).toBe(403);
  });

  it('works for a console session', async () => {
    const res = await call(`/offboard?orgId=${kit.org.id}`, fake.admin(), dry('x@example.test'));
    expect(res.status).toBe(200);
  });
});

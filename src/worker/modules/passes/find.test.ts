import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
const names = ['Ana Ruiz', 'Cy Dunn', 'Ed Lowe', 'Ana Moss'];

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  for (const memberName of names) await kit.pass({ memberName, holderEmail: 'h@example.com' });
  await kit.pass({ memberName: 'Ana Test', mode: 'test' });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...auth.admin(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const list = async (match: unknown) => {
  const res = await call(
    'GET',
    `/passes?orgId=${kit.org.id}&count=true&match=${encodeURIComponent(JSON.stringify(match))}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { items: unknown[]; count: number };
};

describe('find passes by input', () => {
  it('matches text that starts with or contains a value, and counts in this mode only', async () => {
    const starts = await list([{ input: 'memberName', op: 'startsWith', value: 'ana' }]);
    expect([starts.items.length, starts.count]).toEqual([2, 2]);
    const has = await list([{ input: 'memberName', op: 'contains', value: 'U' }]);
    expect(has.count).toBe(2);
    const both = await list([
      { input: 'memberName', op: 'startsWith', value: 'Ana' },
      { input: 'memberName', op: 'contains', value: 'moss' },
    ]);
    expect(both.count).toBe(1);
    const wild = await list([{ input: 'memberName', op: 'contains', value: '%' }]);
    expect(wild.count).toBe(0);
  });

  it('refuses more than five clauses', async () => {
    const clause = { input: 'memberName', op: 'contains', value: 'a' };
    const res = await call(
      'GET',
      `/passes?orgId=${kit.org.id}&match=${encodeURIComponent(JSON.stringify(Array(6).fill(clause)))}`,
    );
    expect(res.status).toBe(422);
  });
});

describe('bulk by filter', () => {
  const filter = { match: [{ input: 'memberName', op: 'startsWith', value: 'Ana' }] };
  const bulk = (expectCount: number, extra: object = {}) =>
    call('POST', '/passes/bulk', {
      action: 'void',
      orgId: kit.org.id,
      selection: { filter, expectCount },
      ...extra,
    });

  it('refuses a count that drifted, and changes nothing', async () => {
    const res = await bulk(40);
    await expectProblem(res, 409, 'SELECTION_CHANGED');
    expect(
      (
        (await (await call('GET', `/passes?orgId=${kit.org.id}&status=voided`)).json()) as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);
  });

  it('refuses ids together with a selection', async () => {
    const res = await bulk(2, { ids: ['x'] });
    expect(res.status).toBe(422);
  });

  it('voids what matches in this mode and organization only', async () => {
    const res = await bulk(2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { done: number }).done).toBe(2);
    const voided = await call('GET', `/passes?orgId=${kit.org.id}&status=voided&count=true`);
    expect(((await voided.json()) as { count: number }).count).toBe(2);
  });
});

describe('saved views', () => {
  const views = [
    { id: 'monthly', name: 'Monthly', filter: { match: [{ input: 'plan', values: ['Monthly'] }] } },
  ];
  it('keeps the list per organization and refuses duplicates', async () => {
    expect((await call('PUT', '/passes/views', { orgId: kit.org.id, items: views })).status).toBe(
      200,
    );
    const got = await call('GET', `/passes/views?orgId=${kit.org.id}`);
    expect(((await got.json()) as { items: unknown[] }).items).toEqual(views);
    const dup = await call('PUT', '/passes/views', {
      orgId: kit.org.id,
      items: [...views, ...views],
    });
    expect(dup.status).toBe(422);
  });

  it('does not read or write another organization', async () => {
    const other = await makeOrg(kit.fx);
    expect((await call('GET', `/passes/views?orgId=${other.id}`)).status).toBeGreaterThanOrEqual(
      403,
    );
    const res = await call('PUT', '/passes/views', { orgId: other.id, items: [] });
    expect(res.status).toBeGreaterThanOrEqual(403);
    const user = await app.request(
      `${ORIGIN}/api/v1/passes/views?orgId=${kit.org.id}`,
      { headers: auth.user() },
      kit.env,
    );
    expect(user.status).toBeGreaterThanOrEqual(403);
  });
});

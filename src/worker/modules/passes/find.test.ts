import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { maskAddresses } from '../../../shared/contracts/pass-views.ts';
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

const call = (method: string, path: string, body?: unknown, headers = auth.admin()) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
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
    const res = await bulk(3);
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
  const read = async (mode?: 'test') =>
    (await (
      await call(
        'GET',
        `/passes/views?orgId=${kit.org.id}`,
        undefined,
        auth.admin(mode ? { mode } : {}),
      )
    ).json()) as { items: unknown[]; revision: number };

  it('keeps the list per organization and mode, with a revision', async () => {
    const put = (items: unknown[], revision: number, mode?: 'test') =>
      call(
        'PUT',
        '/passes/views',
        { orgId: kit.org.id, items, revision },
        auth.admin(mode ? { mode } : {}),
      );
    expect((await put(views, 0)).status).toBe(200);
    expect(await read()).toEqual({ items: views, revision: 1 });
    expect(await read('test')).toEqual({ items: [], revision: 0 });
    // A save made on a stale revision is refused.
    await expectProblem(await put([], 0), 409, 'VIEWS_CHANGED');
    expect((await put([], 1)).status).toBe(200);
    expect((await read()).revision).toBe(2);
    expect(
      (
        await call('PUT', '/passes/views', {
          orgId: kit.org.id,
          items: [...views, ...views],
          revision: 2,
        })
      ).status,
    ).toBe(422);
  });

  it('stores no holder address', async () => {
    const res = await call('PUT', '/passes/views', {
      orgId: kit.org.id,
      items: [{ id: 'x', name: 'Ana', filter: { holderEmail: 'ana@example.com' } }],
      revision: 0,
    });
    expect(res.status).toBe(422);
  });

  it('stores no address-looking value in q or a match value either', async () => {
    const { revision } = await read();
    const put = (filter: unknown) =>
      call('PUT', '/passes/views', {
        orgId: kit.org.id,
        items: [{ id: 'y', name: 'Y', filter }],
        revision,
      });
    expect((await put({ q: 'ana@example.com' })).status).toBe(422);
    expect(
      (await put({ match: [{ input: 'memberName', op: 'contains', value: 'a@b.co' }] })).status,
    ).toBe(422);
    expect((await put({ match: [{ input: 'plan', values: ['a@b.co'] }] })).status).toBe(422);
    expect((await put({ q: 'ana' })).status).toBe(200);
  });

  it('masks addresses in a filter for the audit', () => {
    expect(
      maskAddresses({
        holderEmail: 'a@b.co',
        q: 'x@y.co',
        match: [
          { input: 'm', op: 'contains', value: 'p@q.co' },
          { input: 'plan', values: ['Monthly'] },
        ],
      }),
    ).toEqual({
      holderEmail: '[hidden]',
      q: '[hidden]',
      match: [
        { input: 'm', op: 'contains', value: '[hidden]' },
        { input: 'plan', values: ['Monthly'] },
      ],
    });
  });

  it('does not read or write another organization', async () => {
    const other = await makeOrg(kit.fx);
    expect((await call('GET', `/passes/views?orgId=${other.id}`)).status).toBeGreaterThanOrEqual(
      403,
    );
    const res = await call('PUT', '/passes/views', { orgId: other.id, items: [], revision: 0 });
    expect(res.status).toBeGreaterThanOrEqual(403);
    const user = await app.request(
      `${ORIGIN}/api/v1/passes/views?orgId=${kit.org.id}`,
      { headers: auth.user() },
      kit.env,
    );
    expect(user.status).toBeGreaterThanOrEqual(403);
  });
});

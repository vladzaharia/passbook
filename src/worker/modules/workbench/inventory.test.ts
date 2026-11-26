import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WORKBENCH_ROUTES } from '../../../shared/contracts/workbench.ts';
import { buildOpenApiDocument } from '../../platform/openapi-document.ts';
import { WORKBENCH_NEVER } from './inventory.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const ACCOUNT_LEVEL = new Set(['GET /api/v1/workbench/contexts']);
const DUMMY = '019e0000-0000-7000-8000-000000000000';

describe('L1: the Workbench route inventory', () => {
  it('lists each route once, and none the design never allows', () => {
    expect(new Set(WORKBENCH_ROUTES).size).toBe(WORKBENCH_ROUTES.length);
    for (const route of WORKBENCH_ROUTES)
      for (const [never, why] of WORKBENCH_NEVER)
        expect(never.test(route), `${route}: ${why}`).toBe(false);
  });

  it('names only routes the app serves, and the document marks exactly those x-workbench: test', () => {
    const served = new Set(t.app.routes.map((r) => `${r.method} ${r.path}`));
    for (const route of WORKBENCH_ROUTES) expect(served.has(route), route).toBe(true);
    const doc = buildOpenApiDocument(t.app) as {
      paths: Record<string, Record<string, { 'x-workbench'?: string }>>;
    };
    const marked = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => op?.['x-workbench'] === 'test')
        .map(([method]) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
    );
    expect(marked.sort()).toEqual([...WORKBENCH_ROUTES].sort());
  });

  it('the account-level contexts read answers the signed-in browser without a token', async () => {
    const m = await t.member();
    const res = await t.call('GET', '/workbench/contexts', m.browser);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('every allowlisted route takes a member token: no 401 and no route refusal', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    for (const route of WORKBENCH_ROUTES) {
      // The account-level read rides the session cookie alone (no bearer): the shell's boundary test holds it so.
      if (ACCOUNT_LEVEL.has(route)) continue;
      const [method = 'GET', path = ''] = route.split(' ');
      const concrete = path.replace(/:[A-Za-z0-9_]+/g, DUMMY).replace('/api/v1', '');
      const res = await t.call(method, concrete, t.asClient(token), {});
      expect(res.status, `${route}: ${await res.clone().text()}`).not.toBe(401);
      if (res.status === 403)
        expect(((await res.json()) as { code: string }).code, route).not.toBe(
          'WORKBENCH_TEST_ONLY',
        );
    }
  });
});

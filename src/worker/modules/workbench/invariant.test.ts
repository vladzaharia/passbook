import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { WORKBENCH_ROUTES } from '../../../shared/contracts/workbench.ts';
import { takesBearer } from '../../platform/auth.ts';
import { enforcesKeyAccess } from '../../platform/openapi-security.ts';
import { BROWSER, bearer, ORIGIN, workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const LIVE = { 'x-passbook-mode': 'live' };
const DUMMY = '019e0000-0000-7000-8000-000000000000';
/**
 * Routes that never read a bearer: open on purpose, or their credential is their own (a signed link, an
 * invitation or pairing code). A token adds nothing there (route-inventory.test.ts PUBLIC and OWN_GUARD).
 */
const OWN_CREDENTIAL = new Set([
  'GET /api/v1/docs',
  'GET /api/v1/openapi.json',
  'GET /api/v1/session',
  'GET /api/v1/org-exports/:exportId/download',
  'GET /api/v1/orgs/invitations/accept',
  'POST /api/v1/orgs/invitations/preview',
  'POST /api/v1/invitations/claim-existing',
  'POST /api/v1/invitations/preview',
  'POST /api/v1/invitations/setup',
  'POST /api/v1/scan/pair',
  'POST /api/v1/scan/pair/preview',
  'POST /api/v1/scan/unpair',
]);

describe('L2: a token asking for Live gets 403 WORKBENCH_TEST_ONLY', () => {
  it('member token, one route per module', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    for (const path of ['/passes', '/events', '/webhook-endpoints', '/test-inbox', '/api-keys'])
      await expectProblem(
        await t.call('GET', path, { ...t.asClient(token), ...LIVE }),
        403,
        'WORKBENCH_TEST_ONLY',
      );
    // A mode header other than live is not a request for Live: the token is Test.
    const test = await t.call('GET', '/passes', {
      ...t.asClient(token),
      'x-passbook-mode': 'test',
    });
    expect(test.status).toBe(200);
  });

  it('sandbox token, through requireCaller and the other key guards', async () => {
    const d = await t.developer();
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    for (const path of [
      '/passes',
      `/templates/${d.made.templateId}`,
      '/api-keys/me',
      '/developer/logs',
    ])
      await expectProblem(
        await t.call('GET', path, { ...t.asClient(token), ...LIVE }),
        403,
        'WORKBENCH_TEST_ONLY',
      );
    // The try token alias follows the same rule.
    const alias = await t.mint(d.browser);
    await expectProblem(
      await t.call('GET', '/passes', { ...d.browser, ...bearer(alias.token), ...LIVE }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
  });
});

/** Every method route the app serves under /api/v1, as `METHOD /path`. */
function apiRoutes(): string[] {
  const keys = t.app.routes
    .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/'))
    .map((r) => `${r.method} ${r.path}`);
  return [...new Set(keys)].sort();
}

describe('L3: deny by default', () => {
  it('a member token gets 401 or 403 WORKBENCH_TEST_ONLY on every route off the allowlist', async () => {
    const allowed = new Set(WORKBENCH_ROUTES);
    const routes = apiRoutes().filter((key) => !allowed.has(key));
    expect(routes.length).toBeGreaterThan(300);
    const refused: Record<string, number> = {};
    const reached: string[] = [];
    // RL_API_TRY counts per session: a fresh member and token every 40 calls.
    for (let i = 0; i < routes.length; i += 40) {
      const m = await t.member();
      const { token } = await t.wbMint(m.browser, m.orgId);
      for (const key of routes.slice(i, i + 40)) {
        const [method = 'GET', path = ''] = key.split(' ');
        const concrete = path.replace(/:[A-Za-z0-9_]+/g, DUMMY).replace(/\*/g, 'x');
        const res = await t.call(method, concrete.replace('/api/v1', ''), t.asClient(token), {});
        const code = res.status === 403 ? ((await res.json()) as { code?: string }).code : '';
        if (res.status !== 401 && code !== 'WORKBENCH_TEST_ONLY' && !OWN_CREDENTIAL.has(key))
          reached.push(`${key} ${res.status} ${code}`);
        refused[res.status] = (refused[res.status] ?? 0) + 1;
      }
    }
    expect(reached, reached.join('\n')).toEqual([]);
    // Most routes take a bearer and refuse the token; the rest are for people (cookie) or scanners.
    expect(refused[403] ?? 0).toBeGreaterThan(200);
  }, 240_000);

  it('the same token works on the allowlist', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    expect((await t.call('GET', '/webhook-endpoints', t.asClient(token))).status).toBe(200);
    expect((await t.call('GET', '/test-inbox', t.asClient(token))).status).toBe(200);
  });
});

describe('L5: every route kind', () => {
  it('no ALL endpoint under /api/v1, and no bearer guard outside it', () => {
    // An ALL route is middleware (`use`) when it is a wildcard or shares its path with a method route.
    const methodPaths = new Set(t.app.routes.filter((r) => r.method !== 'ALL').map((r) => r.path));
    for (const r of t.app.routes) {
      if (r.method === 'ALL' && r.path.startsWith('/api/v1/'))
        expect(
          r.path.endsWith('*') || methodPaths.has(r.path),
          `ALL ${r.path} is an endpoint, not middleware`,
        ).toBe(true);
      if (takesBearer(r.handler) || enforcesKeyAccess(r.handler))
        expect(r.path.startsWith('/api/v1/'), `${r.method} ${r.path} takes a bearer`).toBe(true);
    }
  });

  it('on every route a member token adds nothing to its cookie: no success the cookie alone lacks', async () => {
    const allowed = new Set(WORKBENCH_ROUTES);
    const keys = [
      ...new Set(
        t.app.routes
          .filter((r) => !(r.method === 'ALL' && r.path.endsWith('*')))
          .map((r) => `${r.method === 'ALL' ? 'GET' : r.method} ${r.path}`),
      ),
    ]
      .filter((key) => !allowed.has(key))
      .sort();
    expect(keys.length).toBeGreaterThan(400);
    const gained: string[] = [];
    for (let i = 0; i < keys.length; i += 40) {
      const m = await t.member();
      const { token } = await t.wbMint(m.browser, m.orgId);
      for (const key of keys.slice(i, i + 40)) {
        const [method = 'GET', path = ''] = key.split(' ');
        const url = `${ORIGIN}${path.replace(/:[A-Za-z0-9_]+/g, DUMMY).replace(/\*/g, 'x')}`;
        const send = (headers: Record<string, string>) =>
          t.app.request(
            url,
            {
              method,
              headers: { ...headers, 'content-type': 'application/json' },
              ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
            },
            t.kit.env,
          );
        const cookieOnly = (await send({ ...BROWSER, cookie: m.session.headers.cookie ?? '' }))
          .status;
        const withToken = (await send(t.asClient(token))).status;
        if (withToken < 400 && cookieOnly >= 400)
          gained.push(`${key} ${withToken} (cookie ${cookieOnly})`);
      }
    }
    expect(gained, gained.join('\n')).toEqual([]);
  }, 300_000);
});

describe('L6: a sandbox refuses Live for every credential', () => {
  it('session and key: 409 SANDBOX_TEST_ONLY; token: 403; Test works', async () => {
    const d = await t.developer();
    const o = d.made.orgId;
    await expectProblem(
      await t.call('GET', `/passes?orgId=${o}`, { ...d.browser, ...LIVE }),
      409,
      'SANDBOX_TEST_ONLY',
    );
    const inTest = await t.call('GET', `/passes?orgId=${o}`, {
      ...d.browser,
      'x-passbook-mode': 'test',
    });
    expect(inTest.status).toBe(200);
    // The key from a server: no browser signals.
    await expectProblem(
      await t.call('GET', '/passes', { ...bearer(d.key.secret), ...LIVE }),
      409,
      'SANDBOX_TEST_ONLY',
    );
    expect((await t.call('GET', '/passes', bearer(d.key.secret))).status).toBe(200);
    const { token } = await t.wbMint(d.browser, o);
    await expectProblem(
      await t.call('GET', '/passes', { ...t.asClient(token), ...LIVE }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
  });

  it('the 0156 triggers still refuse a Live row in a sandbox', async () => {
    const d = await t.developer();
    const { resolved, registry } = makeTemplate({ id: `tpl-${d.made.orgId}`, orgId: d.made.orgId });
    await expect(
      makePass(t.kit.f, { orgId: d.made.orgId, template: resolved, registry, mode: 'live' }),
    ).rejects.toThrow();
    await expect(
      makePass(t.kit.f, { orgId: d.made.orgId, template: resolved, registry, mode: 'test' }),
    ).resolves.toBeTruthy();
  });
});

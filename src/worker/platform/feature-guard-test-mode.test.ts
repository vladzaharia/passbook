import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { originUnlessKey } from '../../../test/helpers/browser.ts';
import { expectProblem } from '../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../test/helpers/index.ts';
import { MODE_HEADER } from '../../shared/contracts/common.ts';
import { eventMember } from '../modules/holders/test-auth-fixtures.ts';
import { authOf, tenantAuthorityOf } from '../modules/passes/http.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { createAuthStores } from '../stores.ts';
import { grant } from './authority.ts';
import type { Check } from './authority-checks.ts';
import { refusal } from './authority-ext-fixtures.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { type AppBindings, requestContext } from './context.ts';
import { run } from './db.ts';
import { entitled, withinLimit } from './entitlements.ts';
import { handleError } from './error-handler.ts';
import { createRouter, register } from './openapi.ts';

// Test-mode waiver (billing plan AD5): a waivable key passes in Test on a route that opts in
// (`testWaived`) and stays refused in Live; the same key on a route that does not opt in, nfc, a limit and
// an org-wide key are refused in both. No row, no waiver.

type Headers = Record<string, string>;
type Who = 'live session' | 'test session' | 'live key' | 'test key';

let kit: Kit;
let app: Hono<AppBindings>;
let orgId: string;
let bareOrgId: string;
const who = {} as Record<Who, Headers>;
let bareTest: Headers;

const OFF: [string, string][] = [
  ['print', '0'],
  ['nfc', '"off"'],
  ['scanning.devices', '0'],
  ['identity.own', '0'],
];
const overrideIn = (db: D1Database, org: string, key: string, value: string) =>
  run(
    db,
    'INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, ?, ?, 1)',
    [org, key, value],
  );
// Points the org at a preset with no rows, so every key is missing.
const withoutRows = async (db: D1Database, org: string) => {
  await run(
    db,
    "INSERT OR IGNORE INTO entitlement_preset_meta (preset, label, updated_at) VALUES ('no_rows', 'No rows', 1)",
    [],
  );
  await run(db, "UPDATE org_entitlements SET preset = 'no_rows' WHERE org_id = ?", [org]);
};

beforeAll(async () => {
  kit = await setupKit();
  orgId = (await makeOrg(kit.fx)).id;
  for (const [key, value] of OFF) await overrideIn(kit.env.DB, orgId, key, value);
  const session = (await eventMember(kit, orgId, ['pass_operator'])).session.headers;
  const scopes = ['passes:read', 'passes:write'];
  who['live session'] = session;
  who['test session'] = { ...session, [MODE_HEADER]: 'test' };
  who['live key'] = (await makeApiKey(kit.fx, { orgId, scopes })).headers;
  who['test key'] = (await makeApiKey(kit.fx, { orgId, scopes, mode: 'test' })).headers;
  bareOrgId = (await makeOrg(kit.fx)).id;
  await withoutRows(kit.env.DB, bareOrgId);
  const bare = (await eventMember(kit, bareOrgId, ['pass_operator'])).session.headers;
  bareTest = { ...bare, [MODE_HEADER]: 'test' };

  const router = createRouter();
  const auth = { scope: 'passes:read', capability: 'passes:read', requestMode: true } as const;
  const prove = (
    path: string,
    feature: NonNullable<Parameters<typeof register>[2]['auth']>,
    org = () => orgId,
  ) =>
    register(router, 't', { method: 'get', path, summary: path, auth: feature }, async (c) => {
      await tenantAuthorityOf(kit.ctx, authOf(c), org(), 'passes:read');
      return c.json({ ok: true });
    });
  prove('/opted-in', { ...auth, feature: { key: 'print', testWaived: true } });
  prove('/flag', { ...auth, feature: 'print' });
  prove('/no-row', { ...auth, feature: { key: 'print', testWaived: true } }, () => bareOrgId);
  prove('/level', { ...auth, feature: { key: 'nfc', atLeast: 'secure' } });
  prove('/limit', { ...auth, feature: 'scanning.devices' });
  prove('/org-wide', { ...auth, feature: 'identity.own' });
  app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({ stores: (env) => createAuthStores(env, kit.clock), clock: kit.clock }),
  );
  app.onError(handleError);
  app.route('/', router);
});

const call = (path: string, headers: Headers) =>
  app.request(
    `https://wallet.test${path}`,
    { headers: { ...headers, ...originUnlessKey(headers, 'https://wallet.test') } },
    kit.env,
  );

describe('RouteAuth.feature in Test mode', () => {
  const ROUTES: [string, string, boolean][] = [
    ['/opted-in', 'print', true],
    ['/flag', 'print', false],
    ['/level', 'nfc', false],
    ['/limit', 'scanning.devices', false],
    ['/org-wide', 'identity.own', false],
  ];
  for (const [path, feature, waived] of ROUTES)
    for (const mode of ['live', 'test'] as const)
      for (const principal of ['session', 'key'] as const)
        it(`${path} (${feature}): ${mode} ${principal} ${mode === 'test' && waived ? 'passes' : 'is refused'}`, async () => {
          const res = await call(path, who[`${mode} ${principal}`]);
          if (mode === 'test' && waived) {
            expect(res.status).toBe(200);
            return;
          }
          await expectProblem(res, 403, 'FEATURE_NOT_INCLUDED');
          expect(((await res.json()) as { feature?: string }).feature).toBe(feature);
        });

  it('a Test session on an opted-in route is not waived for a key the org has no row for', async () => {
    const res = await call('/no-row', bareTest);
    await expectProblem(res, 403, 'FEATURE_NOT_INCLUDED');
    expect(((await res.json()) as { feature?: string }).feature).toBe('print');
  });
});

describe('entitled() and withinLimit() in Test mode', () => {
  const COUNT = 'SELECT count(*) FROM connections cn WHERE cn.org_id = {org}';
  const cases: [string, Check, boolean][] = [
    ['waivable flag opted in', entitled('print', undefined, { testWaived: true }), true],
    ['waivable flag not opted in', entitled('print'), false],
    ['nfc level', entitled('nfc', 'secure'), false],
    ['limit', entitled('scanning.devices'), false],
    ['limit count', withinLimit('connections', COUNT), false],
    ['org-wide flag', entitled('identity.own'), false],
  ];
  it.each(cases)('%s in Live and Test', async (name, check, waived) => {
    const { s, route, member } = await setupGrant(`waiver-${name.replaceAll(' ', '-')}`);
    for (const [key, value] of [...OFF, ['connections', '0'] as [string, string]])
      await overrideIn(s.f.env.DB, s.org.id, key, value);
    const commit = (mode: 'live' | 'test', purpose = 'org_mode.test.entitled') =>
      refusal(grant(route, { purpose, principal: member({ mode }), checks: [check] }).commit());
    const code = check.reason === 'limit' ? 'FEATURE_LIMIT_REACHED' : 'FEATURE_NOT_INCLUDED';
    expect((await commit('live'))?.code).toBe(code);
    if (waived) expect(await commit('test')).toBeNull();
    else expect((await commit('test'))?.code).toBe(code);
    // An org-scoped grant does not fence its rows by mode, so it never waives.
    expect((await commit('test', 'org.test.entitled'))?.code).toBe(code);
  });

  it('a Test actor is not waived for a key the org has no row for', async () => {
    const { s, route, member } = await setupGrant('waiver-no-row');
    await withoutRows(s.f.env.DB, s.org.id);
    const e = await refusal(
      grant(route, {
        purpose: 'org_mode.test.entitled',
        principal: member({ mode: 'test' }),
        checks: [entitled('print', undefined, { testWaived: true })],
      }).commit(),
    );
    expect(e?.code).toBe('FEATURE_NOT_INCLUDED');
  });

  it('a principal without a mode is not waived', async () => {
    const { s, route, member } = await setupGrant('waiver-no-mode');
    await overrideIn(s.f.env.DB, s.org.id, 'print', '0');
    const e = await refusal(
      grant(route, {
        purpose: 'org_mode.test.entitled',
        principal: member({ mode: null }),
        checks: [entitled('print', undefined, { testWaived: true })],
      }).commit(),
    );
    expect(e?.code).toBe('FEATURE_NOT_INCLUDED');
  });
});

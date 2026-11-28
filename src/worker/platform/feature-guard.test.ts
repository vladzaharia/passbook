import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { originUnlessKey } from '../../../test/helpers/browser.ts';
import { expectProblem } from '../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../test/helpers/index.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  entitledValue,
  presetValues,
} from '../../shared/contracts/entitlements.ts';
import { eventMember } from '../modules/holders/test-auth-fixtures.ts';
import { authOf, tenantAuthorityOf } from '../modules/passes/http.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { createAuthStores } from '../stores.ts';
import type { AuthContext, RouteAuth } from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import { run } from './db.ts';
import { handleError } from './error-handler.ts';
import { checkFeatureRule } from './feature-guard.ts';
import { createRouter, register } from './openapi.ts';

// The request guard (MT2): a key, a session or a platform key calling a route whose feature the org's
// entitlements lack is refused with 403 FEATURE_NOT_INCLUDED, failing closed. There is no installation
// principal yet (WP9): it will take the same path through requireCaller and tenantAuthorityOf.

type Headers = Record<string, string>;
type State = 'on' | 'off' | 'missing';
type Principal = 'session' | 'key' | 'platform key';
const PRINCIPALS: Principal[] = ['session', 'key', 'platform key'];

let kit: Kit;
let app: Hono<AppBindings>;
const orgs = {} as Record<State, string>;
const who = {} as Record<State, Record<Principal, Headers>>;

const override = (orgId: string, key: string, value: string) =>
  run(
    kit.env.DB,
    'INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, ?, ?, 1)',
    [orgId, key, value],
  );

async function principalsOf(orgId: string): Promise<Record<Principal, Headers>> {
  return {
    session: (await eventMember(kit, orgId, ['pass_operator'])).session.headers,
    key: (await makeApiKey(kit.fx, { orgId, scopes: ['passes:read', 'passes:write'] })).headers,
    'platform key': (
      await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read', 'passes:write'] })
    ).headers,
  };
}

beforeAll(async () => {
  kit = await setupKit();
  orgs.on = (await makeOrg(kit.fx)).id; // legacy
  orgs.off = (await makeOrg(kit.fx)).id;
  orgs.missing = (await makeOrg(kit.fx)).id;
  await override(orgs.off, 'webhooks', '0');
  await override(orgs.off, 'nfc', '"off"');
  await override(orgs.off, 'scanning.devices', '0');
  // The keep trigger refuses deleting the row while the org exists: drop it, delete, put it back.
  const keep = await kit.env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'org_entitlements_keep'",
  ).first<{ sql: string }>();
  await run(kit.env.DB, 'DROP TRIGGER org_entitlements_keep');
  await run(kit.env.DB, 'DELETE FROM org_entitlements WHERE org_id = ?', [orgs.missing]);
  await run(kit.env.DB, keep?.sql as string);
  for (const state of ['on', 'off', 'missing'] as const)
    who[state] = await principalsOf(orgs[state]);

  const router = createRouter();
  const prove = (path: string, auth: RouteAuth, method: 'get' | 'post' = 'get') =>
    register(router, 't', { method, path, summary: path, auth }, async (c) => {
      const capability = 'capability' in auth && auth.capability ? auth.capability : 'passes:read';
      await tenantAuthorityOf(kit.ctx, authOf(c), c.req.query('org') ?? '', capability);
      return c.json({ ok: true });
    });
  const scope = { scope: 'passes:read', capability: 'passes:read' } as const;
  prove('/flag', { ...scope, feature: 'webhooks' });
  prove('/level', { ...scope, feature: { key: 'nfc', atLeast: 'basic' } });
  prove('/limit', { ...scope, feature: 'scanning.devices' });
  prove('/human', { human: true, requestMode: true, feature: 'webhooks' });
  prove('/plain', scope);
  prove('/write', { scope: 'passes:write', capability: 'passes:operate' }, 'post');
  register(
    router,
    't',
    {
      method: 'get',
      path: '/skipped',
      summary: 's',
      auth: { scope: 'passes:read', feature: 'webhooks' },
    },
    async (c) => c.json({ ok: true }),
  );
  register(
    router,
    't',
    { method: 'get', path: '/till', summary: 't', auth: { scope: 'scans:write', tillKey: true } },
    async (c) => c.json({ ok: true }),
  );
  register(
    router,
    't',
    { method: 'get', path: '/terminal', summary: 't', auth: { scope: 'scans:write' } },
    async (c) => c.json({ ok: true }),
  );
  app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({ stores: (env) => createAuthStores(env, kit.clock), clock: kit.clock }),
  );
  app.onError(handleError);
  app.route('/', router);
});

const call = (path: string, headers: Headers, orgId: string, method = 'GET') =>
  app.request(
    `https://wallet.test${path}?org=${orgId}`,
    { method, headers: { ...headers, ...originUnlessKey(headers, 'https://wallet.test') } },
    kit.env,
  );

describe('RouteAuth.feature: the guard matrix', () => {
  const ROUTES: [string, EntitlementKey][] = [
    ['/flag', 'webhooks'],
    ['/level', 'nfc'],
    ['/limit', 'scanning.devices'],
  ];

  for (const [path, feature] of ROUTES) {
    for (const principal of PRINCIPALS) {
      it(`${path}: ${principal} passes when on, is refused when off or missing`, async () => {
        expect((await call(path, who.on[principal], orgs.on)).status).toBe(200);
        for (const state of ['off', 'missing'] as const) {
          const res = await call(path, who[state][principal], orgs[state]);
          await expectProblem(res, 403, 'FEATURE_NOT_INCLUDED');
          // An org-bound key without any values fails on `api` first: nothing is entitled.
          const named = state === 'missing' && principal === 'key' ? 'api' : feature;
          expect(((await res.json()) as { feature?: string }).feature).toBe(named);
        }
      });
    }
  }

  it('a session of a human route is guarded like any session', async () => {
    expect((await call('/human', who.on.session, orgs.on)).status).toBe(200);
    for (const state of ['off', 'missing'] as const)
      await expectProblem(
        await call('/human', who[state].session, orgs[state]),
        403,
        'FEATURE_NOT_INCLUDED',
      );
  });

  it('says what is missing, in the design copy, and nothing about the org', async () => {
    const body = (await (await call('/flag', who.off.session, orgs.off)).json()) as {
      detail: string;
    };
    expect(body.detail).toBe(
      "Webhooks isn't included for this organization. Ask PassBook to turn it on.",
    );
  });

  it('refuses a non-member with the ordinary 403, not a feature answer', async () => {
    const res = await call('/flag', who.on.session, orgs.off);
    await expectProblem(res, 403, 'FORBIDDEN');
  });

  it('fails a declared feature whose handler never checked an org (session), at 500', async () => {
    await expectProblem(await call('/skipped', who.on.session, orgs.on), 500, 'FEATURE_UNCHECKED');
  });

  it('checks an org-bound key before the handler, so a handler that skips tenantAuthorityOf is still refused', async () => {
    expect((await call('/skipped', who.on.key, orgs.on)).status).toBe(200);
    await expectProblem(await call('/skipped', who.off.key, orgs.off), 403, 'FEATURE_NOT_INCLUDED');
    await expectProblem(
      await call('/skipped', who.missing.key, orgs.missing),
      403,
      'FEATURE_NOT_INCLUDED',
    );
  });
});

describe('the api level of a key', () => {
  const apiOrg = async (level: string | null) => {
    const orgId = (await makeOrg(kit.fx)).id;
    if (level !== null) await override(orgId, 'api', JSON.stringify(level));
    return {
      orgId,
      key: (await makeApiKey(kit.fx, { orgId, scopes: ['passes:read', 'passes:write'] })).headers,
      platformKey: (
        await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read', 'passes:write'] })
      ).headers,
      session: (await eventMember(kit, orgId, ['pass_operator'])).session.headers,
    };
  };

  it('off refuses every call of an org-bound key; sessions and platform keys are not org API use', async () => {
    const o = await apiOrg('off');
    await expectProblem(await call('/plain', o.key, o.orgId), 403, 'FEATURE_NOT_INCLUDED');
    await expectProblem(await call('/write', o.key, o.orgId, 'POST'), 403, 'FEATURE_NOT_INCLUDED');
    expect((await call('/plain', o.session, o.orgId)).status).toBe(200);
    // A platform key is platform authority: the same on a read, a write and a declared-feature route.
    expect((await call('/plain', o.platformKey, o.orgId)).status).toBe(200);
    expect((await call('/write', o.platformKey, o.orgId, 'POST')).status).toBe(200);
  });

  it('read allows GET and refuses the rest for an org-bound key', async () => {
    const o = await apiOrg('read');
    expect((await call('/plain', o.key, o.orgId)).status).toBe(200);
    const res = await call('/write', o.key, o.orgId, 'POST');
    await expectProblem(res, 403, 'FEATURE_NOT_INCLUDED');
    expect(((await res.json()) as { feature?: string }).feature).toBe('api');
    expect((await call('/write', o.platformKey, o.orgId, 'POST')).status).toBe(200);
  });

  it('full allows both; so does legacy', async () => {
    for (const level of ['full', null]) {
      const o = await apiOrg(level);
      for (const headers of [o.key, o.platformKey]) {
        expect((await call('/plain', headers, o.orgId)).status).toBe(200);
        expect((await call('/write', headers, o.orgId, 'POST')).status).toBe(200);
      }
    }
  });

  it('refuses a key of an org without a row, and a malformed level', async () => {
    await expectProblem(
      await call('/plain', who.missing.key, orgs.missing),
      403,
      'FEATURE_NOT_INCLUDED',
    );
    const o = await apiOrg(null);
    await run(
      kit.env.DB,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'api', '\"huge\"', 1)",
      [o.orgId],
    );
    await expectProblem(await call('/plain', o.key, o.orgId), 403, 'FEATURE_NOT_INCLUDED');
  });

  it('a scans:write key skips api only on a route that declares tillKey', async () => {
    const o = await apiOrg('off');
    const till = (await makeApiKey(kit.fx, { orgId: o.orgId, scopes: ['scans:write'] })).headers;
    expect((await call('/till', till, o.orgId)).status).toBe(200);
    await expectProblem(await call('/terminal', till, o.orgId), 403, 'FEATURE_NOT_INCLUDED');
    // Another scope on a till route is still API.
    const reader = (await makeApiKey(kit.fx, { orgId: o.orgId, scopes: ['scans:read'] })).headers;
    await expectProblem(await call('/till', reader, o.orgId), 403, 'MISSING_SCOPE');
    await expectProblem(await call('/plain', o.key, o.orgId), 403, 'FEATURE_NOT_INCLUDED');
  });

  it('does not let an off org probe another: a key bound elsewhere stays ORG_FORBIDDEN', async () => {
    const o = await apiOrg('off');
    const other = await call('/plain', who.on.key, o.orgId);
    await expectProblem(other, 403, 'ORG_FORBIDDEN');
  });
});

describe('legacy orgs are unchanged', () => {
  it('every key a route may declare is on for the legacy preset, and api is full', () => {
    const legacy = presetValues('legacy');
    for (const key of ENTITLEMENT_KEYS) {
      const def = legacy[key];
      // Every guard rule: a flag or limit passes when on or unlimited; api passes at full, so at read.
      if (key === 'api') expect(entitledValue('api', def, 'full')).toBe(true);
      if (['webhooks', 'templates.uploads', 'scanning.devices', 'connections'].includes(key))
        expect(entitledValue(key, def), key).toBe(true);
    }
    expect(legacy['scanning.devices']).toBeNull();
    expect(legacy['templates.uploads']).toBe(1);
  });

  it('a legacy org (no override) reaches every guarded route as session, key and platform key', async () => {
    for (const path of ['/flag', '/level', '/limit', '/human', '/plain']) {
      for (const principal of PRINCIPALS) {
        if (path === '/human' && principal !== 'session') continue;
        expect((await call(path, who.on[principal], orgs.on)).status, `${path} ${principal}`).toBe(
          200,
        );
      }
    }
    for (const principal of PRINCIPALS)
      expect((await call('/write', who.on[principal], orgs.on, 'POST')).status).toBe(200);
  });
});

describe('declarations', () => {
  it('refuses a rule that cannot mean what it says', () => {
    expect(() => checkFeatureRule('x', 'nfc')).toThrow(/atLeast/); // a bare level
    expect(() => checkFeatureRule('x', { key: 'nfc', atLeast: 'huge' })).toThrow(/atLeast/);
    expect(() => checkFeatureRule('x', { key: 'webhooks', atLeast: 'basic' })).toThrow(
      /not a level/,
    );
    expect(() => checkFeatureRule('x', 'connectors')).toThrow(/list/);
    expect(() => checkFeatureRule('x', 'webhooks')).not.toThrow();
    expect(() => checkFeatureRule('x', { key: 'api', atLeast: 'read' })).not.toThrow();
  });

  it('takes testWaived only on a Test-waivable key', () => {
    expect(() => checkFeatureRule('x', { key: 'print', testWaived: true })).not.toThrow();
    expect(() => checkFeatureRule('x', { key: 'identity.own', testWaived: true })).toThrow(
      /testWaived/,
    );
    expect(() => checkFeatureRule('x', { key: 'nfc', atLeast: 'basic', testWaived: true })).toThrow(
      /testWaived/,
    );
    expect(() => checkFeatureRule('x', { key: 'scanning.devices', testWaived: true })).toThrow(
      /testWaived/,
    );
  });

  it('refuses a feature on a route that has no tenant principal', () => {
    const router = createRouter();
    expect(() =>
      register(
        router,
        't',
        { method: 'get', path: '/x', summary: 'x', auth: { human: true, feature: 'webhooks' } },
        async (c) => c.json({}),
      ),
    ).toThrow(/tenant principal/);
  });
});

describe('principal kinds', () => {
  // WP9 adds an installation principal. This list fails until the new kind is gated (through requireCaller's
  // key branch or tenantAuthorityOf) or named exempt here with its reason.
  it('every principal kind is gated or explicitly exempt', () => {
    const kinds: Record<AuthContext['kind'], 'gated' | 'exempt'> = {
      session: 'gated', // declared features, in tenantAuthorityOf
      api_key: 'gated', // api level (org-bound) and declared features
      scanner: 'exempt', // doors: scanning, not API; own guards in modules/scan
    };
    expect(Object.keys(kinds).sort()).toEqual(['api_key', 'scanner', 'session']);
  });
});

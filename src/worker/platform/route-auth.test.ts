import { env } from 'cloudflare:workers';
import { Hono, type MiddlewareHandler } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type FakeAuth, fakeAuth } from '../../../test/helpers/fake-auth.ts';
import {
  CreateApiKeySchema,
  MINTABLE_PLATFORM_SCOPES,
  MINTABLE_SCOPES,
} from '../../shared/contracts/api-keys.ts';
import { OrgCapabilitySchema, OrgRoleSchema } from '../../shared/contracts/org-membership.ts';
import { createApp } from '../app.ts';
import { delegableScopes } from '../modules/api-keys/access.ts';
import { rolesGranting } from '../modules/orgs/access.ts';
import { requireTenantSession, requireTenantSessionOrApiKey } from '../modules/passes/http.ts';
import {
  isPlatformScope,
  scopeCapability,
  scopeExercises,
  type TenantScope,
} from './api-scopes.ts';
import {
  API_SCOPES,
  type ApiScope,
  type AuthContext,
  methodScope,
  type RouteAuth,
  requireApiKeyOrAdmin,
  requireCaller,
  verifiedScopeOf,
} from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import { run as runSql } from './db.ts';
import type { AppEnv } from './env.ts';
import { handleError } from './error-handler.ts';
import { createRouter, register } from './openapi.ts';
import { keyCallableOnly, withSecurity } from './openapi-security.ts';
import {
  LEGACY_SCOPE_CAPABILITY,
  legacyKeyOrAdmin,
  legacyMethodScope,
  legacyPermitted,
  legacyRequireAdmin,
  legacyRequireSession,
  legacyTagOf,
  legacyTenantSession,
  legacyTenantSessionOrApiKey,
} from './route-auth-legacy.ts';

const ORIGIN = 'https://wallet.test';

// The keys below name org-1. A key's `api` entitlement is checked against its org, and an org with no
// entitlements row is refused (fail closed), so org-1 exists here as a legacy org (all on: nothing changes).
beforeAll(async () => {
  await runSql(
    env.DB,
    "INSERT OR IGNORE INTO orgs (id, slug, name, created_at, updated_at) VALUES ('org-1', 'org-1', 'Org 1', 1, 1)",
  );
  await runSql(
    env.DB,
    "INSERT OR IGNORE INTO org_entitlements (org_id, preset, updated_at) VALUES ('org-1', 'legacy', 1)",
  );
});
type Headers = Record<string, string>;
type Guard = MiddlewareHandler<AppBindings>;
type Principal = (fake: FakeAuth) => Headers;

const withScopes =
  (scopes: ApiScope[]): Principal =>
  (f) =>
    f.apiKey({ orgId: 'org-1', scopes });
const principals: Record<string, Principal> = {
  anonymous: () => ({}),
  admin: (f) => f.admin(),
  'admin in test mode': (f) => f.admin({ mode: 'test' }),
  user: (f) => f.user(),
  'user without csrf token': (f) => ({ ...f.user(), 'x-csrf-token': '' }),
  'user from another origin': (f) => ({
    ...f.user(),
    origin: 'https://evil.test',
    'sec-fetch-site': 'cross-site',
  }),
  'unknown key': () => ({ authorization: 'Bearer wlt_nope_nope' }),
  'key with every scope': withScopes(API_SCOPES.filter((s) => !isPlatformScope(s))),
  'key with passes:read': withScopes(['passes:read']),
  'key with passes:write': withScopes(['passes:write']),
  'key with templates:read': withScopes(['templates:read']),
  'key with webhooks:manage': withScopes(['webhooks:manage']),
  'key with no scopes': withScopes([]),
  'platform key (no org)': (f) =>
    f.apiKey({ orgId: null, scopes: ['passes:read', 'passes:write'] }),
  'test-mode key': (f) => f.apiKey({ orgId: 'org-1', mode: 'test', scopes: ['passes:read'] }),
  'scanner terminal bearer (wls_)': (f) => f.scanner({ transport: 'bearer' }),
  'scanner device cookie': (f) => f.scanner({ transport: 'cookie' }),
  'lowercase bearer scheme': (f) => ({
    authorization: (
      f.apiKey({ orgId: 'org-1', scopes: ['passes:read'] }).authorization ?? ''
    ).replace('Bearer', 'bearer'),
  }),
  'bare Bearer': () => ({ authorization: 'Bearer' }),
  'bare Bearer beside a user cookie': (f) => ({ ...f.user(), authorization: 'Bearer' }),
  'bare Bearer beside an admin cookie': (f) => ({ ...f.admin(), authorization: 'Bearer' }),
  'Bearer with two tokens': () => ({ authorization: 'Bearer wlt_a_b wlt_c_d' }),
  'Bearer with two tokens beside an admin cookie': (f) => ({
    ...f.admin(),
    authorization: 'Bearer a b',
  }),
  'Basic credentials': () => ({ authorization: 'Basic eDp5' }),
  'Basic credentials beside a user cookie': (f) => ({ ...f.user(), authorization: 'Basic eDp5' }),
  'empty Authorization': () => ({ authorization: '' }),
  'unknown key beside an admin cookie': (f) => ({
    ...f.admin(),
    authorization: 'Bearer wlt_nope_nope',
  }),
  'key lacking the scope beside an admin cookie': (f) => ({
    ...f.admin(),
    ...withScopes(['org:read'])(f),
  }),
};

interface Outcome {
  status: number;
  code?: string;
  detail?: string;
  kind?: string;
  roles?: string[];
  mode?: string;
  scopes?: string[];
  tag?: string | null;
  denied: string[];
}

/** One guard in a bare app; reports how it answered and what it left on the context. */
async function run(
  guard: Guard,
  tagOf: (auth: AuthContext) => ApiScope | undefined,
  principal: Principal,
  method: string,
): Promise<Outcome> {
  const fake = fakeAuth(ORIGIN);
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: fake.stores }));
  app.onError(handleError);
  app.on([method], ['/'], guard, (c) => {
    const auth = c.var.auth;
    return c.json({
      kind: auth?.kind,
      roles: auth?.kind === 'session' ? auth.roles : undefined,
      mode: auth?.mode,
      scopes: auth?.kind === 'api_key' ? auth.scopes : undefined,
      tag: auth ? (tagOf(auth) ?? null) : null,
    });
  });
  const res = await app.request(ORIGIN, { method, headers: principal(fake) }, env as AppEnv);
  const body = method === 'HEAD' ? {} : await res.json();
  // The message is compared too: a refusal must say the same thing. The request id never repeats.
  const { requestId: _requestId, ...answer } = body as Record<string, unknown>;
  return { status: res.status, ...answer, denied: fake.denied.map((d) => d.code) } as Outcome;
}

const METHODS = ['GET', 'HEAD', 'POST', 'DELETE'];
const verified = verifiedScopeOf;

/** The declaration and the guard it replaced answer every principal and method the same way. */
async function expectSame(
  declared: Guard,
  legacy: Guard,
  legacyTag: (auth: AuthContext) => ApiScope | undefined = () => undefined,
  /** Principals the declaration deliberately answers differently (see platform-key-isolation.test.ts). */
  except?: RegExp,
) {
  for (const [name, principal] of Object.entries(principals))
    for (const method of METHODS) {
      if (except?.test(name)) continue;
      const [now, before] = await Promise.all([
        run(declared, verified, principal, method),
        run(legacy, legacyTag, principal, method),
      ]);
      // The one deliberate difference: a Bearer header with no key has its own refusal (auth-bearer.test.ts).
      if (now.code === 'API_KEY_MISSING') {
        // Before, a header with no key was no key at all: a cookie beside it still signed the caller in.
        const withoutHeader: Principal = (f) => {
          const { authorization: _gone, ...rest } = principal(f);
          return rest;
        };
        const plain = await run(legacy, legacyTag, withoutHeader, method);
        expect({ status: before.status, code: before.code }).toEqual({
          status: plain.status,
          code: plain.code,
        });
        if (!name.includes('cookie'))
          expect({ status: before.status, code: before.code }).toEqual({
            status: 401,
            code: 'UNAUTHENTICATED',
          });
        continue;
      }
      expect({ name, method, ...now }).toEqual({ name, method, ...before });
    }
}

describe('requireCaller matches the guards it replaced', () => {
  it('scope: a key with the scope or a tenant session', async () => {
    await expectSame(
      requireCaller({ scope: 'passes:read' }),
      legacyTenantSessionOrApiKey('passes:read'),
      legacyTagOf,
    );
  });
  it('scope: any of several', async () => {
    const several: TenantScope[] = ['templates:read', 'passes:read'];
    await expectSame(
      requireCaller({ scope: several }),
      legacyTenantSessionOrApiKey(several),
      legacyTagOf,
    );
    await expectSame(
      requireCaller({ scope: ['webhooks:manage'] }),
      legacyTenantSessionOrApiKey(['webhooks:manage']),
      legacyTagOf,
    );
  });
  it('scope: read scope for GET and HEAD, write scope for the rest', async () => {
    const split = { read: 'passes:read', write: 'passes:write' } as const;
    await expectSame(
      requireCaller({ scope: methodScope(split) }),
      legacyTenantSessionOrApiKey(legacyMethodScope(split)),
      legacyTagOf,
    );
  });
  it('scope with an admin session replaces requireApiKeyOrAdmin', async () => {
    await expectSame(
      requireCaller({ scope: 'passes:read', session: 'admin' }),
      legacyKeyOrAdmin('passes:read'),
    );
    await expectSame(requireApiKeyOrAdmin('passes:read'), legacyKeyOrAdmin('passes:read'));
  });
  it('human with the request mode replaces requireTenantSession', async () => {
    await expectSame(requireCaller({ human: true, requestMode: true }), legacyTenantSession);
  });
  it('human replaces requireSession, and platform replaces requireAdmin', async () => {
    await expectSame(requireCaller({ human: true }), legacyRequireSession);
    // A `platform` route reads a Bearer header: a key never falls back to a cookie, and a platform route that
    // takes no key refuses one (platform-key-isolation.test.ts). Every cookie principal answers as before.
    await expectSame(
      requireCaller({ platform: 'platform:orgs' }),
      legacyRequireAdmin,
      undefined,
      /key|bearer (scheme|\(wls_\))/i,
    );
  });
  it('the passes/http.ts guards are declarations now and keep their behaviour', async () => {
    await expectSame(requireTenantSession, legacyTenantSession);
    await expectSame(
      requireTenantSessionOrApiKey(methodScope({ read: 'passes:read', write: 'passes:write' })),
      legacyTenantSessionOrApiKey(
        legacyMethodScope({ read: 'passes:read', write: 'passes:write' }),
      ),
      legacyTagOf,
    );
    await expectSame(
      requireTenantSessionOrApiKey(['templates:read', 'passes:read']),
      legacyTenantSessionOrApiKey(['templates:read', 'passes:read']),
      legacyTagOf,
    );
  });
});

describe('scope map', () => {
  it('gives every org scope exactly one capability and every platform scope none', () => {
    const capabilities: readonly string[] = OrgCapabilitySchema.options;
    const mapped = Object.keys(scopeCapability).sort();
    expect(mapped).toEqual(API_SCOPES.filter((s) => !isPlatformScope(s)).sort());
    for (const scope of mapped)
      expect(capabilities).toContain(scopeCapability[scope as keyof typeof scopeCapability]);
    expect(API_SCOPES.filter(isPlatformScope).every((s) => !(s in scopeCapability))).toBe(true);
  });
  it('keeps every existing scope on the capability it had', () => {
    for (const [scope, capability] of Object.entries(LEGACY_SCOPE_CAPABILITY))
      expect(scopeCapability[scope as keyof typeof scopeCapability]).toBe(capability);
  });
  it('lets an existing scope exercise exactly the capabilities it did', () => {
    for (const scope of Object.keys(LEGACY_SCOPE_CAPABILITY) as ApiScope[])
      for (const capability of OrgCapabilitySchema.options)
        expect({ scope, capability, ok: scopeExercises(scope, capability) }).toEqual({
          scope,
          capability,
          ok: legacyPermitted(scope, capability),
        });
  });
  it('lets a platform scope exercise nothing', () => {
    for (const scope of API_SCOPES.filter(isPlatformScope))
      for (const capability of OrgCapabilitySchema.options)
        expect(scopeExercises(scope, capability)).toBe(false);
  });
  it('delegates what the creator roles grant, never a platform scope to a member', () => {
    const oldScopes = Object.keys(LEGACY_SCOPE_CAPABILITY);
    const roles = OrgRoleSchema.options;
    for (let mask = 1; mask < 1 << roles.length; mask++) {
      const held = roles.filter((_, i) => mask & (1 << i));
      const authority = { kind: 'session', roles: held } as never;
      const got = delegableScopes(authority);
      const before = oldScopes.filter((scope) =>
        rolesGranting(LEGACY_SCOPE_CAPABILITY[scope as keyof typeof LEGACY_SCOPE_CAPABILITY]).some(
          (role) => held.includes(role),
        ),
      );
      expect(got.filter((s) => oldScopes.includes(s)).sort()).toEqual(before.sort());
      expect(got.some(isPlatformScope)).toBe(false);
      expect(got.every((scope) => MINTABLE_SCOPES.some((m) => m === scope))).toBe(true);
    }
    expect(delegableScopes({ kind: 'platform' } as never)).toEqual([...MINTABLE_SCOPES]);
  });
});

describe('mintable scopes', () => {
  const body = { orgId: 'org-1', name: 'k', scopes: ['passes:read'] };
  // `scanning:write` joined when POST /templates/{id}/scan-setup began to accept it (WP4); `api-keys:write` when
  // the key routes began to accept a key (WP6); `scan-setup:read` when GET /scan-setups did; `nfc:keys` when the keyset routes began to accept a key; `nfc:read` and `nfc:write` when the tag routes did. `templates:write`, `templates:review` and `templates:publish` when Test keys began to release templates; `audit:read` when the org audit routes began to accept a key; `members:read` and `members:write` when the developer invitation routes did.
  it('are a subset of the scopes, and today they are exactly the ones that existed, plus the template write, review and publish, brand kit, scanning setup and key management ones', () => {
    expect([...MINTABLE_SCOPES]).toEqual([
      ...Object.keys(LEGACY_SCOPE_CAPABILITY).flatMap((scope) =>
        scope === 'templates:read'
          ? [scope, 'templates:write', 'templates:review', 'templates:publish']
          : [scope],
      ),
      'brand:manage',
      'org:read',
      'org:write',
      'wallet:write',
      'scanning:write',
      'scan-setup:read',
      'scanning:admin',
      'nfc:keys',
      'nfc:read',
      'nfc:write',
      'api-keys:write',
      'audit:read',
      'members:read',
      'members:write',
      // A Platform key's scopes join as routes accept them (platform-keys L2); route-inventory.test.ts pins the list.
      ...MINTABLE_PLATFORM_SCOPES,
    ]);
  });
  it('are all a key can be created with: any other scope is a validation error', () => {
    expect(CreateApiKeySchema.safeParse(body).success).toBe(true);
    for (const scope of API_SCOPES.filter((s) => !MINTABLE_SCOPES.some((m) => m === s)))
      expect(CreateApiKeySchema.safeParse({ ...body, scopes: [scope] }).success).toBe(false);
  });
  it('are each accepted by some route', async () => {
    const fake = fakeAuth(ORIGIN);
    const res = await createApp({ stores: fake.stores }).request(
      `${ORIGIN}/api/v1/openapi.json`,
      { headers: fake.admin() },
      env as AppEnv,
    );
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    const named = new Set<string>();
    for (const item of Object.values(doc.paths))
      for (const op of Object.values(item))
        for (const entry of op.security ?? [])
          for (const scope of (entry as { apiKey?: string[] }).apiKey ?? []) named.add(scope);
    // `scans:write` is the terminal scope: modules/scan/guard-api-key.ts checks it, not a route rule.
    const unaccepted = MINTABLE_SCOPES.filter((s) => !named.has(s) && s !== 'scans:write');
    expect(unaccepted).toEqual([]);
  });
});

describe('RouteSpec.auth', () => {
  const Ok = z.object({ ok: z.literal(true) });
  function routes() {
    const router = createRouter();
    router.onError(handleError);
    const declare = (path: string, auth: RouteAuth, method: 'get' | 'post' = 'get') =>
      register(router, 't', { method, path, summary: path, response: Ok, auth }, (c) =>
        c.json({ ok: true as const }),
      );
    declare('/keyed', { scope: methodScope({ read: 'passes:read', write: 'passes:write' }) });
    declare(
      '/keyed',
      { scope: methodScope({ read: 'passes:read', write: 'passes:write' }) },
      'post',
    );
    declare('/human', { human: true });
    declare('/platform', { platform: 'platform:orgs' });
    return router;
  }
  const call = (
    router: ReturnType<typeof routes>,
    fake: FakeAuth,
    path: string,
    headers: Headers,
  ) => {
    const app = new Hono<AppBindings>();
    app.use('*', requestContext({ stores: fake.stores }));
    app.route('/', router);
    return app.request(`${ORIGIN}${path}`, { headers }, env as AppEnv);
  };

  it('installs the guard: scope, human only, platform only', async () => {
    const router = routes();
    const fake = fakeAuth(ORIGIN);
    const key = (scopes: ApiScope[]) => fake.apiKey({ orgId: 'org-1', scopes });
    expect((await call(router, fake, '/keyed', key(['passes:read']))).status).toBe(200);
    expect((await call(router, fake, '/keyed', key(['passes:write']))).status).toBe(403);
    expect((await call(router, fake, '/keyed', fake.user())).status).toBe(200);
    expect((await call(router, fake, '/keyed', {})).status).toBe(401);
    expect((await call(router, fake, '/human', key([...API_SCOPES]))).status).toBe(401);
    expect((await call(router, fake, '/human', fake.user())).status).toBe(200);
    expect((await call(router, fake, '/platform', key([...API_SCOPES]))).status).toBe(403);
    expect((await call(router, fake, '/platform', fake.user())).status).toBe(403);
    expect((await call(router, fake, '/platform', fake.admin())).status).toBe(200);
  });

  it('writes the same policy into the document', () => {
    const doc = withSecurity(
      routes() as never,
      routes().getOpenAPI31Document({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
      }) as never,
    ) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(doc.paths['/keyed']?.get?.security).toEqual([
      { apiKey: ['passes:read'] },
      { session: [] },
    ]);
    expect(doc.paths['/keyed']?.post?.security).toEqual([
      { apiKey: ['passes:write'] },
      { session: [] },
    ]);
    expect(doc.paths['/human']?.get).toMatchObject({
      security: [{ session: [] }],
      'x-human-only': true,
    });
    expect(doc.paths['/platform']?.get).toMatchObject({
      security: [{ session: [] }],
      'x-platform-scope': 'platform:orgs',
    });
    expect(Object.keys(keyCallableOnly(doc as never).paths ?? {})).toEqual(['/keyed']);
  });

  it('refuses a capability the scope does not exercise', () => {
    const router = createRouter();
    expect(() =>
      register(
        router,
        't',
        {
          method: 'get',
          path: '/x',
          summary: 'x',
          auth: { scope: 'webhooks:manage', capability: 'templates:read' },
        },
        (c) => c.json({}),
      ),
    ).toThrow(/webhooks:manage does not exercise templates:read/);
    expect(() =>
      register(
        router,
        't',
        {
          method: 'get',
          path: '/y',
          summary: 'y',
          auth: { scope: ['templates:read'], capability: 'templates:read' },
        },
        (c) => c.json({}),
      ),
    ).not.toThrow();
  });

  it('checks a capability only against the scopes the route method accepts', () => {
    const split = methodScope({ read: 'passes:read', write: 'passes:write' });
    const declare = (method: 'get' | 'post', capability: 'passes:read' | 'passes:operate') =>
      register(
        createRouter(),
        't',
        { method, path: '/m', summary: 'm', auth: { scope: split, capability } },
        (c) => c.json({}),
      );
    expect(() => declare('get', 'passes:read')).not.toThrow();
    expect(() => declare('post', 'passes:operate')).not.toThrow();
    expect(() => declare('get', 'passes:operate')).toThrow(/does not exercise/);
  });

  it('refuses a route that is both public and guarded, and marks a public one', () => {
    const router = createRouter();
    expect(() =>
      register(
        router,
        't',
        { method: 'get', path: '/p', summary: 'p', public: true, auth: { human: true } },
        (c) => c.json({}),
      ),
    ).toThrow(/exclusive/);
    expect(() =>
      register(router, 't', { method: 'get', path: '/q', summary: 'q', public: true }, (c) =>
        c.json({}),
      ),
    ).not.toThrow();
  });
});

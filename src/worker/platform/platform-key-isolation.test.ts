import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { PLATFORM_KEY_SCOPES } from '../../shared/contracts/api-keys.ts';
import { OrgCapabilitySchema } from '../../shared/contracts/org-membership.ts';
import { createApp } from '../app.ts';
import { platformActorOf } from './actor.ts';
import { isPlatformScope, scopeExercises, type TenantScope } from './api-scopes.ts';
import { API_SCOPES, type ApiScope } from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import type { AppEnv } from './env.ts';
import { handleError } from './error-handler.ts';
import { createRouter, register } from './openapi.ts';
import { peekBody, platformKeyOf } from './sign-in-guard.ts';

const ORIGIN = 'https://wallet.test';
const Ok = z.object({ ok: z.literal(true) });
const TENANT_SCOPES = API_SCOPES.filter((s): s is TenantScope => !isPlatformScope(s));

/** Fixture routes: one of each platform declaration, and a tenant route. */
function fixture() {
  const router = createRouter();
  const declare = (
    method: 'get' | 'post',
    path: string,
    auth: Parameters<typeof register>[2]['auth'],
  ) =>
    register(router, 't', { method, path, summary: path, response: Ok, auth }, (c) => {
      // The actor is the one a key and a person share: a key's is its own, never a person's.
      const actor = platformActorOf(c);
      return c.json({ ok: true as const, actor: actor.actorType, id: actor.actorId });
    });
  declare('get', '/claims', { platform: 'platform:claims', key: true });
  declare('post', '/claims', { platform: 'platform:claims', key: true });
  declare('get', '/groups', { platform: 'platform:groups', key: true });
  declare('post', '/person', { platform: 'platform:users' });
  declare('get', '/person', { platform: 'platform:users' });
  declare('post', '/offboard', {
    platform: 'platform:users',
    key: { unless: async (c) => (await peekBody(c)).dryRun !== true },
  });
  register(
    router,
    't',
    { method: 'get', path: '/passes', summary: 'p', response: Ok, auth: { scope: 'passes:read' } },
    (c) => c.json({ ok: true as const }),
  );
  const fake = fakeAuth(ORIGIN);
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: fake.stores }));
  app.onError(handleError);
  app.route('/', router);
  const call = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: object = {},
  ) => {
    const init: RequestInit = {
      method,
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
    };
    if (method !== 'GET') init.body = JSON.stringify(body);
    const res = await app.request(`${ORIGIN}${path}`, init, env as AppEnv);
    const json = (await res.json().catch(() => ({}))) as { code?: string; actor?: string };
    return { status: res.status, code: json.code, actor: json.actor };
  };
  return { fake, call };
}

describe('an org key never reaches a platform route', () => {
  it('is refused on every platform declaration, whatever it holds, and the refusal is audited as the key', async () => {
    const { fake, call } = fixture();
    const kinds = ['service', 'personal'] as const;
    for (const keyKind of kinds)
      for (const [method, path] of [
        ['GET', '/claims'],
        ['POST', '/claims'],
        ['GET', '/groups'],
        ['POST', '/person'],
        ['POST', '/offboard'],
      ] as const) {
        const key = fake.apiKey({
          orgId: 'org-1',
          scopes: [...TENANT_SCOPES, ...PLATFORM_KEY_SCOPES],
          keyKind,
        });
        expect(await call(method, path, key), `${keyKind} ${method} ${path}`).toMatchObject({
          status: 403,
          code: 'PLATFORM_KEY_REQUIRED',
        });
      }
    expect(fake.denied.every((d) => d.code === 'PLATFORM_KEY_REQUIRED')).toBe(true);
    expect(fake.denied).toHaveLength(kinds.length * 5);
    expect(fake.denied.every((d) => d.actorType === 'api_key')).toBe(true);
  });

  it('is refused when a forged row pairs the platform kind with an org, or platform scopes with the service kind', async () => {
    const { fake, call } = fixture();
    const kindWithOrg = fake.apiKey({
      orgId: 'org-1',
      scopes: ['platform:claims'],
      keyKind: 'platform',
    });
    const scopesOnService = fake.apiKey({
      orgId: 'org-1',
      scopes: ['platform:claims'],
      keyKind: 'service',
    });
    const noKind = fake.apiKey({ orgId: null, scopes: ['platform:claims'], keyKind: 'service' });
    for (const key of [kindWithOrg, scopesOnService, noKind])
      expect(await call('GET', '/claims', key)).toMatchObject({
        status: 403,
        code: 'PLATFORM_KEY_REQUIRED',
      });
  });

  it('holds no platform scope as tenant authority', () => {
    for (const scope of PLATFORM_KEY_SCOPES)
      for (const capability of OrgCapabilitySchema.options)
        expect(scopeExercises(scope, capability), `${scope} ${capability}`).toBe(false);
  });
});

describe('a Platform key', () => {
  it('passes with the route scope, and never with another platform scope', async () => {
    const { fake, call } = fixture();
    const claims = fake.platformKey({ scopes: ['platform:claims'] });
    expect(await call('GET', '/claims', claims)).toMatchObject({ status: 200, actor: 'api_key' });
    expect(await call('POST', '/claims', claims)).toMatchObject({ status: 200 });
    const groups = fake.platformKey({ scopes: ['platform:groups'] });
    expect(await call('GET', '/claims', groups)).toMatchObject({
      status: 403,
      code: 'MISSING_SCOPE',
    });
    expect(await call('POST', '/claims', groups)).toMatchObject({
      status: 403,
      code: 'MISSING_SCOPE',
    });
  });

  it('reads with platform:read and never writes with it', async () => {
    const { fake, call } = fixture();
    const read = fake.platformKey({ scopes: ['platform:read'] });
    expect(await call('GET', '/claims', read)).toMatchObject({ status: 200 });
    expect(await call('GET', '/groups', read)).toMatchObject({ status: 200 });
    expect(await call('POST', '/claims', read)).toMatchObject({
      status: 403,
      code: 'MISSING_SCOPE',
    });
  });

  it('is refused on every person-only route, even with every platform scope', async () => {
    const { fake, call } = fixture();
    const every = fake.platformKey({ scopes: [...PLATFORM_KEY_SCOPES] });
    for (const [method, path] of [
      ['GET', '/person'],
      ['POST', '/person'],
    ] as const)
      expect(await call(method, path, every)).toMatchObject({
        status: 403,
        code: 'PERSON_REQUIRED',
      });
    expect(fake.denied.map((d) => d.code)).toEqual(['PERSON_REQUIRED', 'PERSON_REQUIRED']);
  });

  it('is refused on the requests a conditional route keeps for a person', async () => {
    const { fake, call } = fixture();
    const users = fake.platformKey({ scopes: ['platform:users'] });
    expect(await call('POST', '/offboard', users, { dryRun: true })).toMatchObject({
      status: 200,
    });
    for (const body of [{ dryRun: false }, {}])
      expect(await call('POST', '/offboard', users, body)).toMatchObject({
        status: 403,
        code: 'PERSON_REQUIRED',
      });
  });

  it('has no tenant route: not with its own scope, not with platform:read', async () => {
    const { fake, call } = fixture();
    for (const scopes of [['platform:read'], [...PLATFORM_KEY_SCOPES]] as ApiScope[][])
      expect(await call('GET', '/passes', fake.platformKey({ scopes }))).toMatchObject({
        status: 403,
        code: 'MISSING_SCOPE',
      });
    // A row that also holds a tenant scope is still no tenant caller once it holds a platform one.
    const mixed = fake.apiKey({
      orgId: null,
      scopes: ['passes:read', 'platform:read'],
      keyKind: 'platform',
    });
    expect(await call('GET', '/passes', mixed)).toMatchObject({
      status: 403,
      code: 'MISSING_SCOPE',
    });
  });

  it('is the Ops read-only key on a platform route: an All organizations key holds no platform scope', async () => {
    const { fake, call } = fixture();
    const ops = fake.apiKey({ orgId: null, scopes: ['passes:read', 'templates:read'] });
    expect(await call('GET', '/claims', ops)).toMatchObject({
      status: 403,
      code: 'MISSING_SCOPE',
    });
    expect(await call('GET', '/passes', ops)).toMatchObject({ status: 200 });
  });

  it('decides alone when a header is sent: a bad key beside a good cookie is 401, and a key beside an admin cookie is no admin', async () => {
    const { fake, call } = fixture();
    expect(
      await call('GET', '/claims', { ...fake.admin(), authorization: 'Bearer wlt_nope_nope' }),
    ).toMatchObject({ status: 401, code: 'INVALID_API_KEY' });
    const users = fake.platformKey({ scopes: ['platform:users'] });
    expect(await call('POST', '/person', { ...fake.admin(), ...users })).toMatchObject({
      status: 403,
      code: 'PERSON_REQUIRED',
    });
    expect(await call('POST', '/claims', { ...fake.admin(), ...users })).toMatchObject({
      status: 403,
      code: 'MISSING_SCOPE',
    });
    expect(await call('POST', '/claims', fake.admin())).toMatchObject({
      status: 200,
      actor: 'user',
    });
  });
});

describe('every person-only route of the app refuses a key', () => {
  it('answers a Platform key holding every platform scope with PERSON_REQUIRED (or 401 behind a session-only router guard)', async () => {
    const fake = fakeAuth(ORIGIN);
    const app = createApp({ stores: fake.stores });
    const person = app.routes.filter((r) => platformKeyOf(r.handler) === 'person');
    expect(person.length).toBeGreaterThan(0);
    const headers = fake.platformKey({ scopes: [...PLATFORM_KEY_SCOPES] });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const wrong: string[] = [];
    for (const r of person) {
      const url = `${ORIGIN}${r.path.replace(/:[A-Za-z0-9_]+/g, 'x')}`;
      const init: RequestInit = {
        method: r.method,
        headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      };
      if (!['GET', 'HEAD', 'DELETE'].includes(r.method)) init.body = '{}';
      const res = await app.fetch(new Request(url, init), env as AppEnv, ctx);
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (!(res.status === 403 && body.code === 'PERSON_REQUIRED') && res.status !== 401)
        wrong.push(`${r.method} ${r.path}: ${res.status} ${body.code}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});

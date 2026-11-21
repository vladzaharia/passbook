import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { requireCaller } from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import type { AppEnv } from './env.ts';
import { handleError } from './error-handler.ts';

const ORIGIN = 'https://wallet.test';
const MIN = 60_000;

async function callGuard(
  auth: Parameters<typeof requireCaller>[0],
  headers: Record<string, string>,
  fake = fakeAuth(ORIGIN),
) {
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: fake.stores }));
  app.onError(handleError);
  app.get('/api/v1/x', requireCaller(auth), (c) => c.json({ ok: true }));
  const res = await app.request(`${ORIGIN}/api/v1/x`, { headers }, env as AppEnv);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('step-up at the route guard', () => {
  const auth = { human: true, stepUp: { maxAgeSec: 600 } } as const;

  it('lets a fresh sign-in through', async () => {
    const fake = fakeAuth(ORIGIN);
    const { status } = await callGuard(
      auth,
      fake.session({ authTime: Date.now() - 5 * MIN }),
      fake,
    );
    expect(status).toBe(200);
  });

  it('refuses a stale sign-in and names the way back', async () => {
    const fake = fakeAuth(ORIGIN);
    const { status, body } = await callGuard(
      auth,
      {
        ...fake.session({ authTime: Date.now() - 11 * MIN }),
        referer: `${ORIGIN}/admin/o/o1/members?x=1`,
      },
      fake,
    );
    expect(status).toBe(403);
    expect(body.code).toBe('STEP_UP_REQUIRED');
    expect(body.signInUrl).toBe(
      `/auth/oidc/start?prompt=login&max_age=0&next=${encodeURIComponent('/admin/o/o1/members?x=1')}`,
    );
  });

  it('refuses a session with no auth_time', async () => {
    const fake = fakeAuth(ORIGIN);
    const { status, body } = await callGuard(auth, fake.session({ authTime: null }), fake);
    expect(status).toBe(403);
    expect(body.code).toBe('STEP_UP_REQUIRED');
    expect(body.signInUrl).toContain('next=%2Fadmin');
  });

  it('ignores a Referer from another origin', async () => {
    const fake = fakeAuth(ORIGIN);
    const { body } = await callGuard(
      auth,
      { ...fake.session({ authTime: null }), referer: 'https://evil.test/admin' },
      fake,
    );
    expect(body.signInUrl).toContain('next=%2Fadmin');
    expect(String(body.signInUrl)).not.toContain('evil');
  });

  it('sends a break-glass session back to the token page', async () => {
    const fake = fakeAuth(ORIGIN);
    const { body } = await callGuard(
      auth,
      fake.session({ amr: 'breakglass', authTime: Date.now() - 30 * MIN }),
      fake,
    );
    expect(body.code).toBe('STEP_UP_REQUIRED');
    expect(body.signInUrl).toBe('/auth/breakglass?next=%2Fadmin');
  });

  it('never asks an API key', async () => {
    const fake = fakeAuth(ORIGIN);
    const { status } = await callGuard(
      { scope: 'passes:read', stepUp: { maxAgeSec: 600 } },
      fake.apiKey({ scopes: ['passes:read'] }),
      fake,
    );
    expect(status).toBe(200);
  });
});

// Every sensitive route, called with a stale admin session. A route missing from this list has no
// step-up, and one in it that loses it fails here.
const STALE = Date.now() - 60 * MIN;
const INVITE = { email: 'new@example.test', roles: ['org_admin'] };
const SENSITIVE: [string, string, unknown?][] = [
  [
    'POST',
    '/api/v1/api-keys',
    { orgId: null, name: 'k', kind: 'platform', scopes: ['passes:read'] },
  ],
  [
    'POST',
    '/api/v1/api-keys',
    { orgId: 'o1', name: 'k', kind: 'service', scopes: ['scanning:admin'] },
  ],
  [
    'POST',
    '/api/v1/api-keys',
    { orgId: 'o1', name: 'k', kind: 'personal', scopes: ['passes:read'] },
  ],
  ['POST', '/api/v1/api-keys/k1/rotate', { orgId: 'o1' }],
  ['POST', '/api/v1/orgs/o1/close', {}],
  ['POST', '/api/v1/orgs/o1/reopen'],
  ['POST', '/api/v1/orgs/o1/exports'],
  ['POST', '/api/v1/orgs/o1/exports/e1/link'],
  ['POST', '/api/v1/orgs/o1/invitations', INVITE],
  ['POST', '/api/v1/orgs/o1/identities/apple', {}],
  ['POST', '/api/v1/identities/i1/revoke-certificate', {}],
  ['POST', '/api/v1/webhook-endpoints/w1/secret', {}],
  ['POST', '/api/v1/webhook-endpoints/w1/captures/secret'],
  ['POST', '/api/v1/connections/c1/webhook-secret'],
];

describe('step-up route inventory', () => {
  it.each(SENSITIVE)('%s %s asks for a fresh sign-in', async (method, path, body) => {
    const fake = fakeAuth(ORIGIN);
    const app = createApp({ stores: fake.stores });
    const headers = {
      ...fake.session({ roles: ['admin', 'user'], authTime: STALE }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    const res = await app.request(
      `${ORIGIN}${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env as AppEnv,
    );
    const problem = (await res.json()) as { code?: string };
    expect(problem.code).toBe('STEP_UP_REQUIRED');
    expect(res.status).toBe(403);
  });

  it('does not ask for an invitation without the admin role', async () => {
    const fake = fakeAuth(ORIGIN);
    const app = createApp({ stores: fake.stores });
    const res = await app.request(
      `${ORIGIN}/api/v1/orgs/o1/invitations`,
      {
        method: 'POST',
        headers: {
          ...fake.session({ roles: ['admin', 'user'], authTime: STALE }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...INVITE, roles: ['read_only'] }),
      },
      env as AppEnv,
    );
    expect(((await res.json()) as { code?: string }).code).not.toBe('STEP_UP_REQUIRED');
  });

  it('never asks an API key to mint', async () => {
    const fake = fakeAuth(ORIGIN);
    const app = createApp({ stores: fake.stores });
    const res = await app.request(
      `${ORIGIN}/api/v1/api-keys`,
      {
        method: 'POST',
        headers: {
          ...fake.apiKey({ orgId: 'o1', scopes: ['api-keys:write'] }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ orgId: 'o1', name: 'k', kind: 'service', scopes: ['passes:read'] }),
      },
      env as AppEnv,
    );
    expect(((await res.json()) as { code?: string }).code).not.toBe('STEP_UP_REQUIRED');
  });
});

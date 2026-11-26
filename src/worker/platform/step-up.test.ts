import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { requireCaller } from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import type { AppEnv } from './env.ts';
import { handleError } from './error-handler.ts';
import { buildOpenApiDocument } from './openapi-document.ts';
import { stepUpOf } from './sign-in-guard.ts';

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

// A pending invitation into an administering role, and one into a read-only role, for the resend guard.
beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO orgs (id, slug, name, created_at, updated_at) VALUES ('o1', 'o1', 'O1', 1, 1)",
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, primary_email, created_at) VALUES ('user-1', 'step-up-user@example.test', 1)",
  ).run();
  for (const [id, roles] of [
    ['inv-admin', '["org_admin"]'],
    ['inv-read', '["read_only"]'],
  ] as const)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
       VALUES (?, 'o1', ?, ?, ?, 1, 9999999999999)`,
    )
      .bind(id, `${id}@example.test`, roles, `hash-${id}`)
      .run();
});
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
  ['POST', '/api/v1/orgs/o1/invitations/inv-admin/resend'],
  ['PATCH', '/api/v1/orgs/o1/memberships/m1', { roles: ['org_admin'] }],
  ['PATCH', '/api/v1/orgs/o1/memberships/m1', { roles: ['integration_admin'] }],
  [
    'POST',
    '/api/v1/orgs/o1/invitations',
    { email: 'new@example.test', roles: ['integration_admin'] },
  ],
  ['POST', '/api/v1/orgs/o1/identities/apple', {}],
  ['POST', '/api/v1/identities', {}],
  ['POST', '/api/v1/identities/i1/rotate', {}],
  ['PUT', '/api/v1/identities/i1/push-key', {}],
  ['POST', '/api/v1/identities/i1/revoke-certificate', {}],
  [
    'POST',
    '/api/v1/webhook-endpoints',
    { url: 'https://example.test/h', eventTypes: ['pass.created'] },
  ],
  ['PATCH', '/api/v1/webhook-endpoints/w1', { url: 'https://example.test/h' }],
  ['PATCH', '/api/v1/webhook-endpoints/w1', { eventTypes: ['pass.created'] }],
  ['POST', '/api/v1/webhook-endpoints/w1/secret', {}],
  ['POST', '/api/v1/webhook-endpoints/w1/captures/secret'],
  ['POST', '/api/v1/connections', { orgId: 'o1', secrets: { token: 'x' } }],
  ['PATCH', '/api/v1/connections/c1', { webhookSecret: 'a'.repeat(20) }],
  ['PATCH', '/api/v1/connections/c1', { secrets: { token: 'x' } }],
  ['PATCH', '/api/v1/connections/c1', { config: { host: 'https://example.test' } }],
  ['PATCH', '/api/v1/connections/c1', { mode: 'webhook' }],
  ['POST', '/api/v1/connections/c1/webhook-secret'],
  ['PUT', '/api/v1/settings', { scope: 'platform', values: { 'auth.consoleEmailUntil': null } }],
  ['PUT', '/api/v1/settings', { scope: 'platform', values: { 'oidc.trustEmail': true } }],
  ['POST', '/api/v1/platform/wallet-credentials/w1/rotate-key'],
  ['POST', '/api/v1/nfc/keysets/k1/rotate', {}],
  ['POST', '/api/v1/nfc/keysets/k1/import', { csv: 'x', replace: true, dryRun: false }],
  ['POST', '/api/v1/users/u1/emails', { email: 'x@example.test' }],
];

// Calls that must not be asked: the same routes without the sensitive part.
const NOT_ASKED: [string, string, unknown][] = [
  ['PATCH', '/api/v1/connections/c1', { name: 'Renamed' }],
  ['PATCH', '/api/v1/webhook-endpoints/w1', { description: 'x' }],
  ['POST', '/api/v1/orgs/o1/invitations', { email: 'new@example.test', roles: ['read_only'] }],
  ['POST', '/api/v1/orgs/o1/invitations/inv-read/resend', undefined],
  ['PATCH', '/api/v1/orgs/o1/memberships/m1', { roles: ['pass_operator'] }],
  ['PUT', '/api/v1/settings', { scope: 'platform', values: { 'email.senderName': 'X' } }],
  ['POST', '/api/v1/nfc/keysets/k1/import', { csv: 'x', replace: true, dryRun: true }],
  ['POST', '/api/v1/nfc/keysets/k1/import', { csv: 'x', dryRun: false }],
  // Asked only when an organization is on the preset (presets.test.ts holds that side).
  [
    'PUT',
    '/api/v1/platform/entitlement-presets',
    { preset: 'trial', expectedRevision: 1, values: {} },
  ],
];

async function codeOf(
  fake: ReturnType<typeof fakeAuth>,
  headers: Record<string, string>,
  [method, path, body]: [string, string, unknown?],
) {
  const app = createApp({ stores: fake.stores });
  const res = await app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env as AppEnv,
  );
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
}

describe('step-up route inventory', () => {
  it.each(SENSITIVE)('%s %s asks for a fresh sign-in', async (method, path, body) => {
    const fake = fakeAuth(ORIGIN);
    const got = await codeOf(fake, fake.session({ roles: ['admin', 'user'], authTime: STALE }), [
      method,
      path,
      body,
    ]);
    expect(got).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
  });

  it.each(NOT_ASKED)('%s %s with no sensitive field is not asked', async (method, path, body) => {
    const fake = fakeAuth(ORIGIN);
    const got = await codeOf(fake, fake.session({ roles: ['admin', 'user'], authTime: STALE }), [
      method,
      path,
      body,
    ]);
    expect(got.code).not.toBe('STEP_UP_REQUIRED');
  });

  it.each(SENSITIVE)('%s %s never asks an API key', async (method, path, body) => {
    const fake = fakeAuth(ORIGIN);
    const got = await codeOf(
      fake,
      fake.apiKey({
        orgId: 'o1',
        scopes: ['api-keys:write', 'connections:write', 'webhooks:manage'],
      }),
      [method, path, body],
    );
    expect(got.code).not.toBe('STEP_UP_REQUIRED');
  });

  // The one list of routes that ask, read from the guards themselves. A new one shows here in review.
  const app = createApp({ stores: fakeAuth(ORIGIN).stores });
  const declared = app.routes
    .filter((r) => stepUpOf(r.handler))
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  it('lists every route that asks', () => {
    expect(declared).toMatchInlineSnapshot(`
      [
        "DELETE /api/v1/developer/sandbox",
        "DELETE /api/v1/orgs/:id/developers/:userId",
        "PATCH /api/v1/connections/:id",
        "PATCH /api/v1/orgs/:id/memberships/:membershipId",
        "PATCH /api/v1/webhook-endpoints/:id",
        "POST /api/v1/api-keys",
        "POST /api/v1/api-keys/:id/rotate",
        "POST /api/v1/connections",
        "POST /api/v1/connections/:id/webhook-secret",
        "POST /api/v1/developer/sandbox/recreate",
        "POST /api/v1/developer/sandbox/reopen",
        "POST /api/v1/developer/sandbox/reset",
        "POST /api/v1/identities",
        "POST /api/v1/identities/:id/revoke-certificate",
        "POST /api/v1/identities/:id/rotate",
        "POST /api/v1/nfc/keysets/:id/import",
        "POST /api/v1/nfc/keysets/:id/rotate",
        "POST /api/v1/orgs/:id/developer-invitations",
        "POST /api/v1/orgs/:id/invitations",
        "POST /api/v1/orgs/:id/invitations/:invitationId/resend",
        "POST /api/v1/orgs/:id/status",
        "POST /api/v1/orgs/:orgId/close",
        "POST /api/v1/orgs/:orgId/exports",
        "POST /api/v1/orgs/:orgId/exports/:exportId/link",
        "POST /api/v1/orgs/:orgId/identities/apple",
        "POST /api/v1/orgs/:orgId/reopen",
        "POST /api/v1/platform/wallet-credentials/:id/rotate-key",
        "POST /api/v1/users/:id/emails",
        "POST /api/v1/webhook-endpoints",
        "POST /api/v1/webhook-endpoints/:id/captures/secret",
        "POST /api/v1/webhook-endpoints/:id/secret",
        "PUT /api/v1/identities/:id/push-key",
        "PUT /api/v1/platform/entitlement-presets",
        "PUT /api/v1/settings",
      ]
    `);
  });

  it('marks them in the OpenAPI document', () => {
    const doc = buildOpenApiDocument(app) as unknown as {
      paths: Record<string, Record<string, { 'x-step-up'?: unknown }>>;
    };
    expect(doc.paths['/api/v1/api-keys']?.post?.['x-step-up']).toEqual({
      maxAgeSec: 600,
      conditional: false,
    });
    expect(doc.paths['/api/v1/connections/{id}']?.patch?.['x-step-up']).toEqual({
      maxAgeSec: 600,
      conditional: true,
    });
  });

  // A route that mints, reveals or rotates a secret must ask, or be named here with the reason.
  const SECRET_PATH = /secret|rotate|reveal|revoke-certificate|push-key|\/api-keys$/;
  const EXEMPT: Record<string, string> = {
    // Capability links for holders and joiners, not credentials of the org.
    'POST /api/v1/passes/{id}/rotate-link': 'holder link',
    'POST /api/v1/bundles/{id}/rotate-link': 'holder link',
    'POST /api/v1/join-links/{templateId}/rotate': 'join link',
  };
  it('leaves no secret-minting route without it', () => {
    const doc = buildOpenApiDocument(app) as unknown as {
      paths: Record<string, Record<string, { 'x-step-up'?: unknown }>>;
    };
    const missing: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item)) {
        if (method === 'get' || method === 'delete' || !SECRET_PATH.test(path)) continue;
        const key = `${method.toUpperCase()} ${path}`;
        if (!op['x-step-up'] && !(key in EXEMPT)) missing.push(key);
      }
    expect(missing).toEqual([]);
  });
});

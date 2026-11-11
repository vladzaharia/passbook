import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiKeyFixture,
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { MODE_HEADER } from '../../../shared/contracts/common.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
  tenantKeyScopeOf,
} from './http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const alternatives = ['templates:read', 'passes:read'] as const;
const clock = new ManualClock();
let env: AppEnv;
let fx: Fixtures;
let app: Hono<AppBindings>;
let session: SessionFixture;
let orgId: string;
let foreignOrgId: string;
let livePassId: string;
let testPassId: string;
let foreignPassId: string;
const rotatedKeys = new Map<string, ApiKeyFixture>();

beforeAll(async () => {
  env = await makeEnv({ PUBLIC_BASE_URL: ORIGIN });
  fx = fixtures(env, clock);
  const org = await makeOrg(fx);
  const foreignOrg = await makeOrg(fx);
  orgId = org.id;
  foreignOrgId = foreignOrg.id;

  const user = await makeUser(fx);
  await grantKitMembership(
    { ctx: createServiceContext(env, { clock }), fx, org },
    org.id,
    user.id,
    ['read_only'],
  );
  session = await makeSession(fx, { userId: user.id, roles: ['user'] });

  const { resolved: template, registry } = makeTemplate({ id: fx.ids.id(), orgId: org.id });
  const { resolved: foreignTemplate, registry: foreignRegistry } = makeTemplate({
    id: fx.ids.id(),
    orgId: foreignOrg.id,
  });
  livePassId = (await makePass(fx, { orgId: org.id, template, registry })).id;
  testPassId = (await makePass(fx, { orgId: org.id, template, registry, mode: 'test' })).id;
  foreignPassId = (
    await makePass(fx, {
      orgId: foreignOrg.id,
      template: foreignTemplate,
      registry: foreignRegistry,
    })
  ).id;

  app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(env, clock),
        apiKeys: createApiKeyStore(env, clock),
      },
      clock,
    }),
  );
  app.onError(handleError);
  app.all(
    '/__tenant-alternatives/:orgId',
    requireTenantSessionOrApiKey(alternatives),
    async (c) => {
      const auth = authOf(c);
      const selected = tenantKeyScopeOf(auth);
      const capability = selected === 'passes:read' ? 'passes:read' : 'templates:read';
      const authority = await tenantAuthorityOf(svc(c), auth, c.req.param('orgId'), capability);
      const passId = c.req.query('passId') ?? livePassId;
      const before = await first<{ ok: number }>(
        c.env.DB,
        `SELECT 1 AS ok FROM passes p WHERE p.id = ? AND p.mode = ?
       AND ${tenantPassAuthoritySql(authority, 'p')}`,
        [passId, authority.mode, ...tenantPassAuthorityParams(authority, c.var.clock.now())],
      );

      // Rotate to a narrower key after authority preflight, immediately before the fenced write.
      // Key identity is immutable, so the replacement has a new ID and the old key is revoked.
      const mutation = c.req.query('mutation');
      let selectedScopeStillAuthorized: boolean | null = null;
      let alternativeStillAuthorized: boolean | null = null;
      if (mutation === 'rotate') {
        if (authority.kind !== 'api_key') throw new Error('Expected API-key authority');
        const remaining = authority.scopes.filter((scope) => scope !== authority.scope);
        const remainingScope = remaining[0];
        if (!remainingScope) throw new Error('Expected a remaining alternative');
        const replacement = await makeTenantTestApiKey(fx, {
          orgId: authority.keyOrgId,
          scopes: remaining,
          mode: authority.mode,
        });
        await run(c.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
          c.var.clock.now(),
          authority.keyId,
        ]);
        rotatedKeys.set(authority.keyId, replacement);
        // Use the replacement's real ID and scope list to isolate the selected-scope check.
        const aligned = { ...authority, keyId: replacement.id, scopes: remaining };
        const scopeProbe = await first<{ ok: number }>(
          c.env.DB,
          `SELECT 1 AS ok FROM passes p WHERE p.id = ? AND p.mode = ?
         AND ${tenantPassAuthoritySql(aligned, 'p')}`,
          [passId, aligned.mode, ...tenantPassAuthorityParams(aligned, c.var.clock.now())],
        );
        selectedScopeStillAuthorized = scopeProbe !== null;
        const alternative = { ...aligned, scope: remainingScope };
        const alternativeProbe = await first<{ ok: number }>(
          c.env.DB,
          `SELECT 1 AS ok FROM passes p WHERE p.id = ? AND p.mode = ?
         AND ${tenantPassAuthoritySql(alternative, 'p')}`,
          [passId, alternative.mode, ...tenantPassAuthorityParams(alternative, c.var.clock.now())],
        );
        alternativeStillAuthorized = alternativeProbe !== null;
      }
      let committed: boolean | null = null;
      if (mutation === 'commit' || mutation === 'rotate') {
        const row = await first<{ id: string }>(
          c.env.DB,
          `UPDATE passes SET external_id = ? WHERE id = ? AND passes.mode = ?
         AND ${tenantPassAuthoritySql(authority, 'passes')} RETURNING id`,
          [
            mutation === 'commit' ? 'before-scope-removal' : 'after-scope-removal',
            passId,
            authority.mode,
            ...tenantPassAuthorityParams(authority, c.var.clock.now()),
          ],
        );
        committed = row !== null;
      }
      return c.json({
        authKind: auth.kind,
        principalId: authority.kind === 'api_key' ? authority.keyId : authority.userId,
        selectedScope: selected ?? null,
        authorityScope: authority.kind === 'api_key' ? authority.scope : null,
        authorityScopes: authority.kind === 'api_key' ? authority.scopes : null,
        authorityOrgId: authority.orgId,
        capability,
        mode: authority.mode,
        authorized: before !== null,
        selectedScopeStillAuthorized,
        alternativeStillAuthorized,
        committed,
      });
    },
  );
}, 60_000);

function request(
  headers: Record<string, string>,
  options: {
    method?: 'GET' | 'POST';
    orgId?: string;
    passId?: string;
    mutation?: 'commit' | 'rotate';
  } = {},
) {
  const url = new URL(`/__tenant-alternatives/${options.orgId ?? orgId}`, ORIGIN);
  url.searchParams.set('passId', options.passId ?? livePassId);
  if (options.mutation) url.searchParams.set('mutation', options.mutation);
  return app.request(url.toString(), { method: options.method ?? 'GET', headers }, env);
}

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

describe('tenant alternative-scope middleware', () => {
  it('uses the real session and membership, enforcing CSRF for writes but not reads', async () => {
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = session.headers;
    const read = await request(withoutCsrf);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      authKind: 'session',
      principalId: session.userId,
      selectedScope: null,
      authorityScope: null,
      authorityOrgId: orgId,
      capability: 'templates:read',
      mode: 'live',
      authorized: true,
    });

    await expectProblem(await request(withoutCsrf, { method: 'POST' }), 403, 'CSRF_TOKEN');
    await expectProblem(
      await request(
        { ...session.headers, 'x-csrf-token': 'wrong' },
        {
          method: 'POST',
        },
      ),
      403,
      'CSRF_TOKEN',
    );
    await expectProblem(
      await request(
        { ...session.headers, 'sec-fetch-site': 'cross-site' },
        {
          method: 'POST',
        },
      ),
      403,
      'CSRF_ORIGIN',
    );
    const write = await request(session.headers, { method: 'POST' });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ authKind: 'session', authorized: true });
    await expectProblem(await request({}), 401, 'UNAUTHENTICATED');
  });

  it('uses the session request mode, defaulting unrecognized values to live', async () => {
    for (const [header, expectedMode, passId] of [
      ['TeSt', 'test', testPassId],
      ['testing', 'live', livePassId],
    ] as const) {
      const response = await request({ ...session.headers, [MODE_HEADER]: header }, { passId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mode: expectedMode, authorized: true });
    }
    const mismatch = await request({ ...session.headers, [MODE_HEADER]: 'test' });
    expect(mismatch.status).toBe(200);
    expect(await mismatch.json()).toMatchObject({ mode: 'test', authorized: false });
  });

  it.each(alternatives)('accepts and tags a key holding only %s', async (scope) => {
    const key = await makeApiKey(fx, { orgId, scopes: [scope] });
    const response = await request(
      { ...key.headers, 'sec-fetch-site': 'cross-site' },
      {
        method: 'POST',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authKind: 'api_key',
      principalId: key.id,
      selectedScope: scope,
      authorityScope: scope,
      authorityScopes: [scope],
      authorityOrgId: orgId,
      capability: scope,
      mode: 'live',
      authorized: true,
    });
  });

  it('keeps the key mode instead of accepting the session mode header', async () => {
    const key = await makeTenantTestApiKey(fx, {
      orgId,
      scopes: ['templates:read'],
      mode: 'test',
    });
    const response = await request(
      { ...key.headers, [MODE_HEADER]: 'live' },
      { passId: testPassId },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authKind: 'api_key',
      selectedScope: 'templates:read',
      mode: 'test',
      authorized: true,
    });
    const mismatch = await request({ ...key.headers, [MODE_HEADER]: 'live' });
    expect(mismatch.status).toBe(200);
    expect(await mismatch.json()).toMatchObject({ mode: 'test', authorized: false });
  });

  it('forbids a real key holding neither alternative even alongside a valid session', async () => {
    const key = await makeApiKey(fx, { orgId, scopes: ['passes:write', 'holders:write'] });
    await expectProblem(
      await request({ ...session.headers, ...key.headers }),
      403,
      'MISSING_SCOPE',
    );
  });

  it('rejects invalid and revoked bearer keys rather than falling back to a valid session', async () => {
    const key = await makeApiKey(fx, { orgId, scopes: ['templates:read'] });
    const tampered = `${key.secret.slice(0, -1)}${key.secret.endsWith('A') ? 'B' : 'A'}`;
    await expectProblem(
      await request({ ...session.headers, authorization: `Bearer ${tampered}` }),
      401,
      'INVALID_API_KEY',
    );
    await run(env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [clock.now(), key.id]);
    await expectProblem(
      await request({ ...session.headers, ...key.headers }),
      401,
      'INVALID_API_KEY',
    );
  });

  it('denies a foreign org and fences foreign pass rows for sessions and org-bound keys', async () => {
    const key = await makeApiKey(fx, { orgId, scopes: ['passes:read'] });
    await expectProblem(
      await request(session.headers, { orgId: foreignOrgId, passId: foreignPassId }),
      403,
      'FORBIDDEN',
    );
    await expectProblem(
      await request(key.headers, { orgId: foreignOrgId, passId: foreignPassId }),
      403,
      'ORG_FORBIDDEN',
    );
    for (const headers of [session.headers, key.headers]) {
      const response = await request(headers, {
        method: 'POST',
        passId: foreignPassId,
        mutation: 'commit',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        authorityOrgId: orgId,
        authorized: false,
        committed: false,
      });
    }
    expect(
      await first(env.DB, 'SELECT external_id FROM passes WHERE id = ?', [foreignPassId]),
    ).toEqual({ external_id: null });
  });

  it('binds the first held alternative through the final D1 mutation', async () => {
    // Stored scope order is deliberately reversed: the middleware's alternatives determine priority.
    const key = await makeApiKey(fx, { orgId, scopes: ['passes:read', 'templates:read'] });
    const before = await request(key.headers, { method: 'POST', mutation: 'commit' });
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      selectedScope: 'templates:read',
      authorityScope: 'templates:read',
      authorityScopes: ['passes:read', 'templates:read'],
      authorized: true,
      committed: true,
    });

    const raced = await request(key.headers, { method: 'POST', mutation: 'rotate' });
    expect(raced.status).toBe(200);
    expect(await raced.json()).toMatchObject({
      selectedScope: 'templates:read',
      authorityScope: 'templates:read',
      authorityScopes: ['passes:read', 'templates:read'],
      authorized: true,
      committed: false,
      selectedScopeStillAuthorized: false,
      alternativeStillAuthorized: true,
    });
    expect(
      await first(env.DB, 'SELECT scopes, revoked_at FROM api_keys WHERE id = ?', [key.id]),
    ).toEqual({ scopes: '["passes:read","templates:read"]', revoked_at: clock.now() });
    const replacement = rotatedKeys.get(key.id);
    if (!replacement) throw new Error('Expected a replacement key');
    expect(
      await first(env.DB, 'SELECT scopes FROM api_keys WHERE id = ?', [replacement.id]),
    ).toEqual({ scopes: '["passes:read"]' });
    expect(
      await first(env.DB, 'SELECT external_id FROM passes WHERE id = ?', [livePassId]),
    ).toEqual({ external_id: 'before-scope-removal' });
    await expectProblem(await request(key.headers), 401, 'INVALID_API_KEY');

    // A new request uses the replacement key; the old snapshot cannot commit.
    const fresh = await request(replacement.headers);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({
      principalId: replacement.id,
      selectedScope: 'passes:read',
      authorityScope: 'passes:read',
      authorityScopes: ['passes:read'],
      authorized: true,
    });
  });
});

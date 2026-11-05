import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fakeAuth, fakeRateLimiter, makeEnv } from '../../../test/helpers/index.ts';
import { createApp } from '../app.ts';
import {
  assertOrgAccess,
  requireAdmin,
  requireApiKeyOrAdmin,
  requireSession,
  type ScannerAuth,
} from './auth.ts';
import { type AppBindings, actorOf, requestContext } from './context.ts';
import { derivedHmacKey } from './crypto.ts';
import { csrfGuard } from './csrf.ts';
import { handleError } from './error-handler.ts';
import { ForbiddenError } from './errors.ts';
import { checkRateLimit } from './rate-limit.ts';

const ORIGIN = 'https://wallet.test';
const scannerAuth: ScannerAuth = {
  kind: 'scanner',
  scannerId: 's1',
  orgId: 'org-1',
  mode: 'live',
  transport: 'cookie',
  csrfSecret: 'secret',
};

function guarded(fake = fakeAuth(ORIGIN)) {
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: fake.stores }));
  app.onError(handleError);
  // A scanner principal already on the context, as scan middleware would leave it.
  app.use('*', async (c, next) => {
    c.set('auth', scannerAuth);
    await next();
  });
  app.get('/session', requireSession, (c) => c.json({ ok: true }));
  app.get('/admin', requireAdmin, (c) => c.json({ ok: true }));
  app.get('/key', requireApiKeyOrAdmin('passes:read'), (c) => c.json({ ok: true }));
  return { app, fake };
}

describe('scanner principal', () => {
  it('never satisfies requireSession, requireAdmin or requireApiKeyOrAdmin', async () => {
    const { app } = guarded();
    for (const path of ['/session', '/admin', '/key'])
      expect((await app.request(`${ORIGIN}${path}`, {}, env as never)).status).toBe(401);
  });

  it('a wls bearer on /api/v1/passes is 401', async () => {
    const fake = fakeAuth(ORIGIN);
    const app = createApp({ stores: fake.stores });
    const res = await app.request(
      `${ORIGIN}/api/v1/passes`,
      { headers: fake.scanner({ transport: 'bearer' }) },
      env as never,
    );
    expect(res.status).toBe(401);
  });

  it('actorOf maps a scanner', () => {
    expect(actorOf(scannerAuth)).toEqual({ type: 'scanner', id: 's1' });
  });

  it('assertOrgAccess refuses another org', () => {
    expect(() => assertOrgAccess(scannerAuth, 'org-1')).not.toThrow();
    expect(() => assertOrgAccess(scannerAuth, 'org-2')).toThrow(ForbiddenError);
  });
});

describe('csrf for scanners', () => {
  function csrfApp() {
    const fake = fakeAuth(ORIGIN);
    const app = new Hono<AppBindings>();
    app.use('*', requestContext({ stores: fake.stores }));
    app.onError(handleError);
    app.post('/x', async (c) => {
      const token =
        c.req.header('cookie')?.split('=')[1] ?? c.req.header('authorization')?.slice(7);
      const auth = token
        ? await c.var.stores.scanners.resolve(token, c.req.header('cookie') ? 'cookie' : 'bearer')
        : null;
      if (!auth) return c.json({}, 401);
      await csrfGuard(c, auth);
      return c.json({ ok: true });
    });
    return { app, fake };
  }
  const post = (app: Hono<AppBindings>, headers: Record<string, string>) =>
    app.request(`${ORIGIN}/x`, { method: 'POST', headers }, env as never);

  it('cookie plus the right token passes', async () => {
    const { app, fake } = csrfApp();
    expect((await post(app, fake.scanner())).status).toBe(200);
  });

  it('cookie with a wrong or missing token is 403', async () => {
    const { app, fake } = csrfApp();
    const wrong = { ...fake.scanner(), 'x-csrf-token': 'nope' };
    expect((await post(app, wrong)).status).toBe(403);
    expect(fake.denied.at(-1)).toMatchObject({ code: 'CSRF_TOKEN', actorType: 'scanner' });
    const { 'x-csrf-token': _drop, ...missing } = fake.scanner();
    expect((await post(app, missing)).status).toBe(403);
  });

  it('cookie from another origin is 403', async () => {
    const { app, fake } = csrfApp();
    const cross = { ...fake.scanner(), 'sec-fetch-site': 'cross-site' };
    expect((await post(app, cross)).status).toBe(403);
  });

  it('the bearer is exempt', async () => {
    const { app, fake } = csrfApp();
    expect((await post(app, fake.scanner({ transport: 'bearer' }))).status).toBe(200);
  });
});

describe('derivedHmacKey', () => {
  const mac = async (key: CryptoKey) =>
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('m')));

  it('is stable per label and differs across labels', async () => {
    const e = await makeEnv();
    const a1 = await mac(await derivedHmacKey(e, 'scan-pin'));
    const a2 = await mac(await derivedHmacKey(e, 'scan-pin'));
    const b = await mac(await derivedHmacKey(e, 'other'));
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it('throws without a KEK', async () => {
    await expect(derivedHmacKey({}, 'scan-pin')).rejects.toThrow('No KEK');
  });
});

describe('scan rate limits', () => {
  it.each(['RL_SCAN_PAIR', 'RL_SCAN', 'RL_SCAN_LOOKUP', 'RL_SCAN_ORG'] as const)(
    'a missing %s binding is a 503',
    async (name) => {
      const e = await makeEnv({ [name]: undefined } as never);
      await expect(checkRateLimit(e, name, 'k')).rejects.toMatchObject({ status: 503 });
    },
  );

  it('a present binding passes', async () => {
    const e = await makeEnv({ RL_SCAN: fakeRateLimiter({ limit: 1 }) });
    expect(await checkRateLimit(e, 'RL_SCAN', 'k')).toBe(true);
  });
});

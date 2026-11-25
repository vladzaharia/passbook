import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { requireCaller } from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import type { AppEnv } from './env.ts';
import { handleError } from './error-handler.ts';

async function call(authorization: string | null, scope: boolean) {
  const fake = fakeAuth('https://wallet.test');
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: fake.stores }));
  app.onError(handleError);
  app.get('/', requestCaller(scope), (c) => c.json({ ok: true }));
  const headers: Record<string, string> = authorization === null ? {} : { authorization };
  const res = await app.request('https://wallet.test/', { headers }, env as AppEnv);
  return { status: res.status, body: (await res.json()) as { code?: string; detail?: string } };
}

const requestCaller = (scope: boolean) =>
  requireCaller(scope ? { scope: 'passes:read' } : { human: true });

describe('empty Bearer header', () => {
  it.each([
    'Bearer',
    'Bearer ',
    'bearer  ',
    'Bearer undefined',
    'Bearer None',
    'Bearer null',
    'Bearer $PASSBOOK_KEY',
    `Bearer $\{PASSBOOK_KEY}`,
    'pbp_test_abc123',
  ])('%j answers API_KEY_MISSING on a key route', async (header) => {
    const { status, body } = await call(header, true);
    expect(status).toBe(401);
    expect(body.code).toBe('API_KEY_MISSING');
    expect(JSON.stringify(body)).toContain(
      'Authorization has no key. Set PASSBOOK_KEY and export it.',
    );
  });

  it('an unknown key is still INVALID_API_KEY', async () => {
    const { body } = await call('Bearer wlt_nope_nope', true);
    expect(body.code).toBe('INVALID_API_KEY');
  });

  it('another scheme is not a missing key', async () => {
    const { body } = await call('Basic eDp5', true);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('no header is still UNAUTHENTICATED', async () => {
    const { body } = await call(null, true);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('a person route ignores the header', async () => {
    const { body } = await call('Bearer', false);
    expect(body.code).toBe('UNAUTHENTICATED');
  });
});

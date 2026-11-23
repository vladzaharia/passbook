import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { type ApiKeyAuth, denyAllStores } from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import { handleError } from './error-handler.ts';
import { legacyKeyOrAdmin, legacyTenantSessionOrApiKey } from './route-auth-legacy.ts';

const key: ApiKeyAuth = { kind: 'api_key', keyId: 'k1', orgId: null, scopes: [], mode: 'live' };

function appWith(known: boolean) {
  const app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({
      stores: { ...denyAllStores, apiKeys: { resolve: async () => (known ? key : null) } },
    }),
  );
  app.onError((error, c) => handleError(error, c) as Response);
  app.get('/admin-or-key', legacyKeyOrAdmin('passes:read'), (c) => c.json({}));
  app.get('/tenant', legacyTenantSessionOrApiKey(['passes:read']), (c) => c.json({}));
  return app;
}

async function lines(app: Hono<AppBindings>, path: string) {
  const seen: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((l) => void seen.push(String(l)));
  try {
    const res = await app.request(
      `https://wallet.test${path}`,
      {
        headers: {
          authorization: `Bearer pb_live_ABCDEFGH_${'x'.repeat(43)}`,
        },
      },
      env,
    );
    return {
      status: res.status,
      done: seen
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === 'request.done'),
    };
  } finally {
    spy.mockRestore();
  }
}

describe('the legacy key guards note a refusal on request.done', () => {
  it.each(['/admin-or-key', '/tenant'])('%s: an unknown key carries its prefix', async (path) => {
    const { status, done } = await lines(appWith(false), path);
    expect(status).toBe(401);
    expect(done[0]).toMatchObject({ code: 'INVALID_API_KEY', keyPrefix: 'ABCDEFGH' });
  });

  it.each(['/admin-or-key', '/tenant'])(
    '%s: a known key without the scope carries its id',
    async (path) => {
      const { status, done } = await lines(appWith(true), path);
      expect(status).toBe(403);
      expect(done[0]).toMatchObject({ code: 'MISSING_SCOPE', keyId: 'k1' });
    },
  );
});

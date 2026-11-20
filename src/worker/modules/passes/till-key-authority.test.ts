import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
} from '../../../../test/helpers/index.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import type { AppEnv } from '../../platform/env.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authOf, requireTenantSessionOrApiKey, svc, tenantAuthorityOf } from './http.ts';

const ORIGIN = 'https://wallet.test';
const clock = new ManualClock();
let env: AppEnv;
let fx: Fixtures;
let app: Hono<AppBindings>;
let orgId: string;

beforeAll(async () => {
  env = await makeEnv({ PUBLIC_BASE_URL: ORIGIN });
  fx = fixtures(env, clock);
  orgId = (await makeOrg(fx)).id;
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
  // The same rule and capability twice: only the call site's opt-in differs.
  app.get('/plain/:orgId', requireTenantSessionOrApiKey(['scans:write']), async (c) => {
    await tenantAuthorityOf(svc(c), authOf(c), c.req.param('orgId'), 'passes:operate');
    return c.json({ ok: true });
  });
  app.get('/till/:orgId', requireTenantSessionOrApiKey(['scans:write']), async (c) => {
    await tenantAuthorityOf(svc(c), authOf(c), c.req.param('orgId'), 'passes:operate', {
      tillKey: true,
    });
    return c.json({ ok: true });
  });
});

describe('a till key (scans:write) as tenant authority', () => {
  it('is refused at a call site that did not opt in, and accepted where one did', async () => {
    const key = await makeApiKey(fx, { orgId, scopes: ['scans:write'] });
    const call = (path: string) =>
      app.request(`${ORIGIN}/${path}/${orgId}`, { headers: key.headers }, env);
    expect((await call('plain')).status).toBe(403);
    expect((await call('till')).status).toBe(200);
  });
});

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { RouteAuth } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { createAuthStores } from '../../stores.ts';
import { eventMember } from '../holders/test-auth-fixtures.ts';
import { authOf, tenantAuthorityOf } from './http.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';

let kit: Kit;
let app: Hono<AppBindings>;
let reader: Record<string, string>;
let operator: Record<string, string>;
let key: Record<string, string>;
let foreignKey: Record<string, string>;

const declared: RouteAuth = { scope: 'passes:read', capability: 'passes:read' };

beforeAll(async () => {
  kit = await setupKit();
  reader = (await eventMember(kit, kit.org.id, ['read_only'])).session.headers;
  operator = (await eventMember(kit, kit.org.id, ['pass_operator'])).session.headers;
  key = (await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] })).headers;
  foreignKey = (
    await makeApiKey(kit.fx, { orgId: (await makeOrg(kit.fx)).id, scopes: ['passes:read'] })
  ).headers;
  const router = createRouter();
  const route = (path: string, prove: OrgCapability | null) =>
    register(router, 't', { method: 'get', path, summary: path, auth: declared }, async (c) => {
      if (prove) await tenantAuthorityOf(kit.ctx, authOf(c), kit.org.id, prove);
      return c.json({ ok: true });
    });
  route('/proven', 'passes:read');
  route('/skipped', null);
  route('/other-capability', 'passes:operate');
  app = new Hono<AppBindings>();
  app.use(
    '*',
    requestContext({ stores: (env) => createAuthStores(env, kit.clock), clock: kit.clock }),
  );
  app.onError(handleError);
  app.route('/', router);
});

const call = (path: string, headers: Record<string, string>) =>
  app.request(`https://wallet.test${path}`, { headers }, kit.env);

describe('a declared capability must be proven by the handler', () => {
  it('lets a member and an in-scope key through once the handler proved it', async () => {
    expect((await call('/proven', reader)).status).toBe(200);
    expect((await call('/proven', key)).status).toBe(200);
  });

  it('fails a success response whose handler skipped the proof, for sessions and keys', async () => {
    await expectProblem(await call('/skipped', reader), 500, 'AUTHORITY_UNPROVEN');
    await expectProblem(await call('/skipped', key), 500, 'AUTHORITY_UNPROVEN');
  });

  it('does not count a proof of a different capability for a session', async () => {
    await expectProblem(await call('/other-capability', operator), 500, 'AUTHORITY_UNPROVEN');
  });

  it('keeps the handler refusal when the proof fails', async () => {
    expect((await call('/proven', foreignKey)).status).toBe(403);
  });
});

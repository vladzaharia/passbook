import { Hono } from 'hono';
import { type ApiKeyFixture, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createAuthStores } from '../../stores.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';

export async function eventMember(kit: Kit, orgId: string, roles: OrgRole[] = ['read_only']) {
  const user = await makeUser(kit.fx);
  const membership = await grantKitMembership(kit, orgId, user.id, roles);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  return { user, membership, session };
}

/** Acquire an API-key snapshot through the same scope guard used by the holder routes. */
export async function tenantKeyAuthority(
  kit: Kit,
  key: ApiKeyFixture,
  scope: 'passes:write' | 'holders:write',
  orgId = kit.org.id,
): Promise<TenantPassWrite> {
  const captured: { authority?: TenantPassWrite } = {};
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: createAuthStores, clock: kit.clock }));
  app.post('/', requireTenantSessionOrApiKey(scope), async (c) => {
    captured.authority = await tenantAuthorityOf(kit.ctx, authOf(c), orgId, 'passes:operate');
    return c.json({ ok: true });
  });
  const response = await app.request(
    'https://wallet.test/',
    { method: 'POST', headers: key.headers },
    kit.env,
  );
  if (!captured.authority) throw new Error(`Unable to authorize test API key: ${response.status}`);
  return captured.authority;
}

/** A live session row for the user; returns the id hash a self-remove grant proves at commit. */
export async function ownerSessionId(kit: Kit, userId: string): Promise<string> {
  const session = await makeSession(kit.fx, { userId });
  return sha256Hex(session.cookieValue);
}

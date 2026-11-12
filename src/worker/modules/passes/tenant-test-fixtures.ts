import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { MODE_HEADER, type Mode } from '../../../shared/contracts/common.ts';
import type { ApiScope, AuthStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from '../scan/auth-store.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import type { Kit } from './pass-test-fixtures.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';

export interface TenantTestAuth {
  stores: AuthStores;
  admin(options?: { mode?: Mode }): Record<string, string>;
  user(): Record<string, string>;
  apiKey(options?: {
    orgId?: string | null;
    scopes?: ApiScope[];
    mode?: Mode;
  }): Promise<Record<string, string>>;
  addOrg(orgId: string): Promise<void>;
}

/** Real credentials and organization memberships for pass route tests. */
export async function setupTenantTestAuth(
  kit: Kit,
  orgIds: string[] = [kit.org.id],
): Promise<TenantTestAuth> {
  const adminUser = await makeUser(kit.fx);
  const regularUser = await makeUser(kit.fx);
  const adminSession = await makeSession(kit.fx, {
    userId: adminUser.id,
    roles: ['admin', 'user'],
  });
  const userSession = await makeSession(kit.fx, { userId: regularUser.id });

  async function addOrg(orgId: string): Promise<void> {
    await grantKitMembership(kit, orgId, adminUser.id, ['org_admin']);
  }

  for (const orgId of orgIds) await addOrg(orgId);

  return {
    stores: {
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    admin({ mode } = {}) {
      return {
        ...adminSession.headers,
        origin: 'https://wallet.test',
        ...(mode ? { [MODE_HEADER]: mode } : {}),
      };
    },
    user() {
      return { ...userSession.headers, origin: 'https://wallet.test' };
    },
    async apiKey({
      orgId = null,
      scopes = ['passes:read', 'passes:write', 'holders:write', 'templates:read'],
      mode = 'live',
    } = {}) {
      return (await makeTenantTestApiKey(kit.fx, { orgId, scopes, mode })).headers;
    },
    addOrg,
  };
}

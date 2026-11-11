import {
  type ApiKeyFixture,
  makeApiKey,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { type AuthStores, denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';

/** Real D1 credential stores sharing the same clock as the service under test. */
export function eventStores(kit: Kit): AuthStores {
  return {
    ...denyAllStores,
    sessions: createSessionStore(kit.env, kit.clock),
    apiKeys: createApiKeyStore(kit.env, kit.clock),
  };
}

export interface EventAuth {
  member: { session: SessionFixture };
  key: ApiKeyFixture;
}

export async function eventMember(kit: Kit, orgId: string, roles: OrgRole[] = ['read_only']) {
  const user = await makeUser(kit.fx);
  const membership = await grantKitMembership(kit, orgId, user.id, roles);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  return { user, membership, session };
}

export async function eventAuth(kit: Kit): Promise<EventAuth> {
  const member = await eventMember(kit, kit.org.id);
  const key = await makeApiKey(kit.fx, { orgId: kit.org.id });
  return { member, key };
}

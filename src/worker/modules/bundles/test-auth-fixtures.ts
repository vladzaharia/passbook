import type { FakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import {
  insertBundleApiKey,
  insertBundleSession,
  listBundleOrgs,
} from './repo-test-auth-fixtures.ts';

/** Back legacy route fixtures with real credentials and memberships for commit-time checks. */
export async function seedBundlePrincipal(
  kit: Kit,
  fake: FakeAuth,
  headers: Record<string, string>,
) {
  const raw = headers.authorization?.replace(/^Bearer /, '');
  if (raw) {
    const key = await fake.stores.apiKeys.resolve(raw);
    if (!key) return;
    await insertBundleApiKey(kit, key);
    return;
  }
  const cookie = headers.cookie?.split('=')[1];
  if (!cookie) return;
  const session = await fake.stores.sessions.resolve(cookie);
  if (!session) return;
  const now = kit.clock.now();
  const orgs = await listBundleOrgs(kit);
  for (const org of orgs) await grantKitMembership(kit, org.id, session.userId, ['org_admin']);
  await insertBundleSession(kit, session, now);
}

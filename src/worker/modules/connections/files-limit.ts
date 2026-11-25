import { entitlementsOf } from '../../platform/entitlements.ts';
import { authorityDenied } from '../../platform/errors-denial.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { countConnections } from './repo-files.ts';
import { CONNECTION_CODES } from './repo-grants.ts';

/** The grant checks the connections limit too, but only after the file was parsed and its pages written. */
export async function assertRoomForConnection(ctx: ServiceContext, orgId: string): Promise<void> {
  const limit = (await entitlementsOf(ctx, orgId)).connections;
  if (limit === null) return;
  const held = await countConnections(ctx.env.DB, orgId);
  if (typeof limit !== 'number' || held >= limit)
    throw authorityDenied('limit', { codes: CONNECTION_CODES });
}

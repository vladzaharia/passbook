import { first } from '../../platform/db.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import { authorityDenied } from '../../platform/errors-denial.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { CONNECTION_CODES } from './repo-grants.ts';

/** The grant checks the connections limit too, but only after the file was parsed and its pages written. */
export async function assertRoomForConnection(ctx: ServiceContext, orgId: string): Promise<void> {
  const limit = (await entitlementsOf(ctx, orgId)).connections;
  if (limit === null) return;
  const held =
    (
      await first<{ n: number }>(
        ctx.env.DB,
        'SELECT COUNT(*) AS n FROM connections WHERE org_id = ?',
        [orgId],
      )
    )?.n ?? 0;
  if (typeof limit !== 'number' || held >= limit)
    throw authorityDenied('limit', { codes: CONNECTION_CODES });
}

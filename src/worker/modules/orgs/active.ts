import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Org suspension gate for public pages, Apple endpoints, connections and webhooks. */
export async function isOrgActive(ctx: ServiceContext, orgId: string): Promise<boolean> {
  const row = await first<{ status: string }>(ctx.env.DB, 'SELECT status FROM orgs WHERE id = ?', [
    orgId,
  ]);
  return row?.status === 'active';
}

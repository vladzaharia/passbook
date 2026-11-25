import { localDate } from '../../../shared/zoned.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';

/** `YYYY-MM-DD` for an instant, on the org's calendar. */
export async function orgDay(ctx: ServiceContext, orgId: string, ms: number): Promise<string> {
  return localDate(ms, await readOrgTimeZone(ctx.env.DB, orgId));
}

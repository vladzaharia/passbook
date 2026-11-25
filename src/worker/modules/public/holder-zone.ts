import type { ServiceContext } from '../../platform/service-context.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';

/** The zone a holder page reads times in: the pass's org zone (else Seattle), never the visitor's. */
export const holderZone = (ctx: ServiceContext, orgId: string): Promise<string> =>
  readOrgTimeZone(ctx.env.DB, orgId);

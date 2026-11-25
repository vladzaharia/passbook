import type { ServiceContext } from '../../platform/service-context.ts';
import type { C } from '../passes/http.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';

/** Visitor zone from Cloudflare, if it is a zone Intl knows. */
function zoneOf(c: C): string | undefined {
  const tz = c.req.raw.cf?.timezone;
  if (typeof tz !== 'string' || !tz) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** The zone a holder page reads times in: the visitor's, else the org's. */
export async function holderZone(c: C, ctx: ServiceContext, orgId: string): Promise<string> {
  return zoneOf(c) ?? (await readOrgTimeZone(ctx.env.DB, orgId));
}

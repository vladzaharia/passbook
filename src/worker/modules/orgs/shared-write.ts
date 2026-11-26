import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isDeveloperOrg } from '../passes/repo-authority.ts';

/**
 * Org state has no mode: the brand kit, settings, zones, tag types and saved mappings are read by Live passes,
 * emails, pages and scanners. A Test key never changes it, unless the org is a sandbox with no Live side to hurt.
 */
export async function assertSharedWrite(
  ctx: ServiceContext,
  principal: { kind: string; mode?: string },
  orgId: string,
  what: string,
): Promise<void> {
  if (principal.kind !== 'api_key' || principal.mode !== 'test') return;
  if (await isDeveloperOrg(ctx.env.DB, orgId)) return;
  throw new ForbiddenError(`Use a live key to change ${what}.`, 'MODE_LIVE_REQUIRED');
}

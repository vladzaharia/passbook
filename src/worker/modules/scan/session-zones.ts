import type { Admits } from '../../../shared/contracts/scanners.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { storedAdmits } from './admits.ts';
import { sessionZoneIds, zonesInOrg, zonesOpen } from './repo-zones.ts';

/**
 * Zones a session may check: each is a zone of the session's org (a foreign or unknown id is a 404),
 * a new link is to a live zone (an archived one stays linked until the list drops it), and an event
 * session takes none. The grant proves the same at commit, so the read only decides the answer.
 * Returns the checks to add to the grant.
 */
export async function sessionZoneChecks(
  ctx: ServiceContext,
  orgId: string,
  zoneIds: readonly string[],
  eventId: string | null | undefined,
  sessionId?: string,
): Promise<Check[]> {
  if (zoneIds.length === 0) return [];
  if (eventId)
    throw new ValidationError('An event session takes no zones.', [], 'ZONE_EVENT_SESSION');
  const found = await zonesInOrg(ctx.env.DB, orgId, zoneIds);
  if (found.length !== new Set(zoneIds).size)
    throw new NotFoundError('Zone not found.', 'ZONE_NOT_FOUND');
  const linked = sessionId ? await sessionZoneIds(ctx.env.DB, orgId, sessionId) : [];
  const added = found.filter((z) => !linked.includes(z.id));
  if (added.some((z) => z.archived))
    throw new ValidationError('This zone is archived.', [], 'ZONE_ARCHIVED');
  return zonesOpen(added.map((z) => z.id));
}

/** An update that moves a session onto an event while zones stay linked is refused. */
export async function assertNoZonesLeft(
  ctx: ServiceContext,
  orgId: string,
  sessionId: string,
): Promise<void> {
  if ((await sessionZoneIds(ctx.env.DB, orgId, sessionId)).length > 0)
    throw new ValidationError('An event session takes no zones.', [], 'ZONE_EVENT_SESSION');
}

/** The first event of an event-only scope: such a session takes no zones. */
export const eventOnly = (
  admits: Admits | { admits: Admits } | null | undefined,
): string | null => {
  const lists = admits && 'admits' in admits ? admits.admits : admits;
  return lists && lists.templateIds.length === 0 ? (lists.eventIds[0] ?? null) : null;
};

/** The first event of a stored event-only `accepts`, if any. */
export const eventOfAccepts = (raw: string | null): string | null => eventOnly(storedAdmits(raw));

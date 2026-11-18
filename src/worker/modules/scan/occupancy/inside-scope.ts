// The places Who's in covers: what a session checks, or what a console zone or event holds.
import type { ScanActor } from '../guard.ts';
import { orgZoneRows, sessionZoneIds } from '../repo-zones.ts';
import { eventPlace, type OccZone, zonePlace } from './rules.ts';

export interface ScopePlace {
  place: string;
  name: string;
  /** The nearest tracked zone above it that is in scope. */
  parentName: string | null;
  capacity: number | null;
  maxStayMs: number | null;
}

export interface InsideScope {
  places: ScopePlace[];
  /** child place -> parent place, for places in scope. */
  nested: Record<string, string>;
}

const tracked = (z: OccZone) => z.occupancy !== 'off' && z.archivedAt === null;
export const MAX_SCOPE_PLACES = 64;

/** The tracked zones in the subtrees of `rootIds`, in tree order. */
export function zoneScope(zones: readonly OccZone[], rootIds: readonly string[]): InsideScope {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const inScope = new Set<string>();
  const below = (id: string): string[] => [
    id,
    ...zones.filter((z) => z.parentId === id).flatMap((z) => below(z.id)),
  ];
  for (const root of rootIds) for (const id of below(root)) inScope.add(id);
  const live = zones.filter((z) => inScope.has(z.id) && tracked(z));
  const liveIds = new Set(live.map((z) => z.id));
  const parentOf = (z: OccZone): OccZone | null => {
    for (let at = z.parentId, n = 0; at && n < 8; n++) {
      const up = byId.get(at);
      if (!up) return null;
      if (liveIds.has(up.id)) return up;
      at = up.parentId;
    }
    return null;
  };
  const places: ScopePlace[] = [];
  const nested: Record<string, string> = {};
  for (const z of live.slice(0, MAX_SCOPE_PLACES)) {
    const up = parentOf(z);
    if (up) nested[zonePlace(z.id)] = zonePlace(up.id);
    places.push({
      place: zonePlace(z.id),
      name: z.name,
      parentName: up?.name ?? null,
      capacity: z.capacity,
      maxStayMs: z.maxStayMinutes === null ? null : z.maxStayMinutes * 60_000,
    });
  }
  return { places, nested };
}

/** What the actor's session checks: its linked tracked zones and those below, plus its event when it tracks exits. */
export async function sessionInsideScope(db: D1Database, actor: ScanActor): Promise<InsideScope> {
  const scope: InsideScope = { places: [], nested: {} };
  if (actor.scanningSession) {
    const ids = await sessionZoneIds(db, actor.orgId, actor.scanningSession.id);
    if (ids.length) Object.assign(scope, zoneScope(await orgZoneRows(db, actor.orgId), ids));
  }
  const { event } = actor;
  if (event?.reentry && event.archivedAt === null)
    scope.places.push({
      place: eventPlace(event.id),
      name: event.name,
      parentName: null,
      capacity: event.capacity,
      maxStayMs: null,
    });
  return scope;
}

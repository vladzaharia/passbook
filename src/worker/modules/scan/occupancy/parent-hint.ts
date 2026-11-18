import type { ScanOutcome } from '../../../../shared/contracts/scan.ts';
import { enforcingParent } from './rules.ts';
import { occupancyZones } from './service.ts';

/**
 * A `not_inside` hold on an entry names the zone to be in first, so the scanner can say "Tap in at Gym
 * first". The hold is built inside the commit, so the name is added here, only for that rare answer.
 */
export async function withParentHint(
  db: D1Database,
  orgId: string,
  outcome: ScanOutcome,
): Promise<ScanOutcome> {
  const o = outcome.occupancy;
  if (outcome.reason !== 'not_inside' || !o || o.place.kind !== 'zone' || o.direction !== 'in')
    return outcome;
  const parent = enforcingParent(await occupancyZones(db, orgId), o.place.id);
  return parent
    ? { ...outcome, occupancy: { ...o, parent: { id: parent.id, name: parent.name } } }
    : outcome;
}

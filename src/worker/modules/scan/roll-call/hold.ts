import { heldPlaces } from './repo.ts';

/** A call left open this long stops holding exits: a forgotten call must not keep people inside for good. */
export const HOLD_HORIZON_MS = 12 * 60 * 60 * 1000;

const key = (orgId: string, mode: string, place: string) => `${orgId}|${mode}|${place}`;

/**
 * While a roll call is open, the minute cron leaves Max stay and Clear at alone in its places, so no one
 * drops off the muster. The exits happen on the first run after the call ends.
 */
export async function loadHold(db: D1Database, now: number): Promise<(row: HeldRow) => boolean> {
  const held = new Set<string>();
  for (const r of await heldPlaces(db, now, HOLD_HORIZON_MS))
    for (const p of JSON.parse(r.places) as { place: string }[])
      held.add(key(r.org_id, r.mode, p.place));
  return (row) => held.has(key(row.org_id, row.mode, row.scope));
}

interface HeldRow {
  org_id: string;
  mode: string;
  scope: string;
}

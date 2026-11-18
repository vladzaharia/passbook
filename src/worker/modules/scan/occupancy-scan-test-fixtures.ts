import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { makeDoor, makeZone, uid } from './access-test-fixtures.ts';
import { act, HOUR, kit, out } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

/** A zone that counts who's inside, saved an hour ago (an undo treats a fresh save as a change). */
export async function trackedZone(
  o: {
    occupancy?: 'off' | 'track' | 'enforce';
    capacity?: number;
    parentId?: string;
    maxStayMinutes?: number;
  } = {},
): Promise<string> {
  const id = await makeZone(`z-${uid()}`, o.parentId ? { parentId: o.parentId } : {});
  const occupancy = o.occupancy ?? 'track';
  const off = occupancy === 'off';
  await run(
    kit.env.DB,
    'UPDATE scan_zones SET occupancy = ?, capacity = ?, max_stay_minutes = ?, updated_at = ? WHERE id = ?',
    [
      occupancy,
      off ? null : (o.capacity ?? null),
      off ? null : (o.maxStayMinutes ?? 720),
      kit.clock.now() - HOUR,
      id,
    ],
  );
  return id;
}

/** A door that checks these zones, In (default), Out or Both. */
export async function zoneDoor(tpl: string, zoneIds: string[], direction?: 'in' | 'out' | 'both') {
  const d = await makeDoor([tpl], zoneIds);
  if (direction)
    await run(
      kit.env.DB,
      'UPDATE scanning_sessions SET settings = json_set(settings, ?, ?) WHERE id = ?',
      ['$.direction', direction, d.sessionId],
    );
  return d;
}

/** Scan at a door; `direction` is the pinned or dock direction. */
export const scanAt = async (
  d: { headers: Record<string, string> },
  pass: Pass,
  direction?: 'in' | 'out',
): Promise<ScanOutcome> =>
  out(
    await act(d.headers, codeOf(pass), {
      actionId: 'check_in',
      ...(direction ? { direction } : {}),
    }),
  );

export const undoScan = (d: { headers: Record<string, string> }, scanId: string | null) =>
  kit.post(d.headers, `/scans/${scanId}/undo`, { idempotencyKey: key() });

export const placeRow = (passId: string, zoneId: string) =>
  first<{ state: string; entered_at: number | null; due_at: number | null; last_scan_id: string }>(
    kit.env.DB,
    'SELECT state, entered_at, due_at, last_scan_id FROM scan_presence WHERE pass_id = ? AND scope = ?',
    [passId, `zone:${zoneId}`],
  );

export const inNow = async (zoneId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM scan_presence WHERE scope = ? AND state = 'in'",
      [`zone:${zoneId}`],
    )
  )?.n ?? 0;

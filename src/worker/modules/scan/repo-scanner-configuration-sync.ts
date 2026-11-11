import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { setSessionDeviceTemplates } from './repo-admin-unguarded.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';

type Json = Record<string, unknown>;

/** RFC 7396 merge patch, as `json_patch` applies it: objects merge, null removes. */
function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Json =
    base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Json) } : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** The devices of a session are exactly these scanners (the set read before the edit). */
export function sessionDevicesAre(sessionId: string, devices: readonly ScanningDeviceRow[]): Check {
  const csv = devices
    .map((d) => d.scanner_id)
    .sort()
    .join(',');
  return tenantCheck(
    'config',
    `(SELECT COALESCE(group_concat(x.scanner_id), '') FROM (SELECT d.scanner_id
      FROM scanning_devices d WHERE d.session_id = ? AND d.org_id = {org} AND d.mode = {mode}
      ORDER BY d.scanner_id) x) = ?`,
    [sessionId, csv],
  );
}

/**
 * Only changed session policy is propagated; metadata never reconstructs the scope. Each device
 * keeps its own overrides over the session settings; the devices are the set read for the edit.
 */
export function addSessionPropagation(
  g: Grant,
  session: ScanningSessionRow,
  devices: readonly ScanningDeviceRow[],
  patch: {
    settings: boolean;
    timeZone: boolean;
    accepts?: { eventId: string | null; templateIds: string[] };
  },
  now: number,
): GrantedStatement[] {
  const statements: GrantedStatement[] = [];
  for (const device of devices) {
    const set: Record<string, SetValue> = {};
    if (patch.settings)
      set.settings = JSON.stringify(
        mergePatch(JSON.parse(session.settings), JSON.parse(device.overrides)),
      );
    if (patch.timeZone) set.time_zone = session.time_zone;
    if (patch.accepts !== undefined) set.event_id = patch.accepts.eventId;
    if (Object.keys(set).length === 0) continue;
    set.updated_at = maxNow(now);
    statements.push(g.update('scanners', { set, where: { id: device.scanner_id } }));
  }
  if (patch.accepts !== undefined)
    statements.push(...setSessionDeviceTemplates(g, session.id, patch.accepts.templateIds));
  return statements;
}

/** Sync only explicitly changed fields to a legacy standalone session (its id is the scanner's). */
export function addScannerPatchSessionSync(
  g: Grant,
  id: string,
  patch: { name?: string; settings?: string; accepts?: string | null; mode?: string },
  now: number,
): GrantedStatement {
  const set: Record<string, SetValue> = { updated_at: maxNow(now) };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.settings !== undefined) set.settings = patch.settings;
  if (patch.accepts !== undefined) set.accepts = patch.accepts;
  if (patch.mode !== undefined) set.mode = patch.mode;
  return g.update('scanning_sessions', { set, where: { id } });
}

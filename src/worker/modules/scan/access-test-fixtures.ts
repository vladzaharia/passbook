import type { AccessManifest } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { act, CHECK_IN, kit, out } from './act-test-fixtures.ts';

export const WORK_DAYS = ['06:00-16:00'];
export const HOURS = {
  mon: WORK_DAYS,
  tue: WORK_DAYS,
  wed: WORK_DAYS,
  thu: WORK_DAYS,
  fri: WORK_DAYS,
};

export const ACCESS: AccessManifest = {
  input: {
    plan: 'plan',
    zones: 'zones',
    from: 'validFrom',
    until: 'validUntil',
    visits: 'visits',
    sponsor: 'sponsor',
  },
  plans: [
    { id: 'gold', label: '24/7 Gold', kind: 'always', zones: [{ zone: '*' }] },
    { id: 'off_peak', label: 'Off-peak', kind: 'timed', hours: HOURS, zones: [{ zone: '*' }] },
    { id: 'pool_only', label: 'Pool only', kind: 'always', zones: [{ zone: 'pool' }] },
    { id: 'guest', label: 'Guest day', kind: 'guest', zones: [{ zone: '*' }], visits: 2 },
  ],
  suspend: { input: 'status', equals: ['Suspended'] },
  rules: { visitGapMinutes: 120 },
};

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export const accessTemplate = (access: AccessManifest = ACCESS, name = 'Access card') =>
  kit.scanTemplate(name, { actions: [CHECK_IN], access });

/** A zone of the test org (no HTTP: the zone routes have their own tests). */
export async function makeZone(
  key: string,
  options: { parentId?: string; timeZone?: string; orgId?: string; archived?: boolean } = {},
): Promise<string> {
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO scan_zones (id, org_id, key, name, parent_id, time_zone, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.orgId ?? kit.org.id,
      key,
      `Zone ${key}`,
      options.parentId ?? null,
      options.timeZone ?? null,
      now,
      now,
      options.archived ? now : null,
    ],
  );
  return id;
}

/** A door: a paired scanner in its own scanning session that checks these zones. */
export async function makeDoor(templateIds: string[], zoneIds: string[] = []) {
  const scanner = await kit.scanner({ templateIds });
  const sessionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
     SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
    [sessionId, JSON.stringify({ templateIds }), scanner.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, scanner.id],
  );
  for (const [sort, zoneId] of zoneIds.entries())
    await run(
      kit.env.DB,
      'INSERT INTO scanning_session_zones (session_id, zone_id, sort) VALUES (?, ?, ?)',
      [sessionId, zoneId, sort],
    );
  return { scanner, sessionId, headers: scanner.headers };
}

export const grantOf = async (
  headers: Record<string, string>,
  pass: { scanCode: string | null },
): Promise<ScanOutcome> =>
  out(await act(headers, { code: pass.scanCode ?? '', method: 'camera' as const }));

export const gateRow = (passId: string) =>
  first<{ count: number; last_scan_id: string; last_at: number; prev_last_at: number | null }>(
    kit.env.DB,
    "SELECT count, last_scan_id, last_at, prev_last_at FROM scan_gates WHERE pass_id = ? AND action_id = 'access' AND scope = 'access'",
    [passId],
  );

export const scanRows = (passId: string) =>
  all<{
    id: string;
    outcome: string;
    reason: string | null;
    zone_id: string | null;
    visit: number | null;
    access_plan: string | null;
  }>(
    kit.env.DB,
    'SELECT id, outcome, reason, zone_id, visit, access_plan FROM scans WHERE pass_id = ? ORDER BY at, id',
    [passId],
  );

export { uid };

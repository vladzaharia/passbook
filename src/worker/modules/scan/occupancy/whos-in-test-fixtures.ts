import { all, run } from '../../../platform/db.ts';
import { CHECK_IN } from '../act-test-fixtures.ts';
import type { ScanKit } from '../test-kit.ts';

let kit: ScanKit;
/** The kit these helpers build on: the action fixture's or the sessions fixture's. */
export const useKit = (k: ScanKit) => {
  kit = k;
};

let seq = 0;
const uid = () => (seq++).toString(36);

export async function trackedZone(
  o: { parentId?: string; occupancy?: string; maxStayMinutes?: number; orgId?: string } = {},
): Promise<{ id: string; name: string }> {
  const id = kit.fx.ids.id();
  const name = `Zone ${uid()}`;
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO scan_zones (id, org_id, key, name, parent_id, time_zone, occupancy, max_stay_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      o.orgId ?? kit.org.id,
      name.toLowerCase().replace(/ /g, '-'),
      name,
      o.parentId ?? null,
      o.parentId ? null : 'UTC',
      o.occupancy ?? 'track',
      o.maxStayMinutes ?? null,
      now,
      now,
    ],
  );
  return { id, name };
}

export interface Station {
  scanner: Awaited<ReturnType<ScanKit['scanner']>>;
  headers: Record<string, string>;
  sessionId: string;
}

/** A paired device in its own session that checks `zoneIds`; role and settings as given. */
export async function station(
  templateIds: string[],
  zoneIds: string[],
  o: {
    deviceRole?: 'scan' | 'monitor' | 'customer';
    deskActions?: boolean;
    role?: 'door' | 'desk';
    staffSignIn?: boolean;
    status?: 'active' | 'paused';
  } = {},
): Promise<Station> {
  const scanner = await kit.scanner({
    templateIds,
    deviceRole: o.deviceRole ?? 'scan',
    settings: {
      roleWithoutSignIn: o.role ?? 'desk',
      ...(o.deskActions === undefined ? {} : { deskActions: o.deskActions }),
      ...(o.staffSignIn === undefined ? {} : { staffSignIn: o.staffSignIn }),
    },
  });
  const sessionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
     SELECT ?,org_id,mode,name,?,?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
    [sessionId, o.status ?? 'active', JSON.stringify({ templateIds }), scanner.id],
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
  return { scanner, headers: scanner.headers, sessionId };
}

/** A pass with `name`, inside each place since `at`, as an entry would leave it. */
export async function personInside(
  tpl: string,
  name: string,
  places: string[],
  o: {
    at?: number;
    mode?: 'live' | 'test';
    orgId?: string;
    dueAt?: number | null;
    input?: Record<string, unknown>;
  } = {},
) {
  const pass = await kit.scanPass(
    tpl,
    { memberName: name, ...o.input },
    { ...(o.mode ? { mode: o.mode } : {}), ...(o.orgId ? { orgId: o.orgId } : {}) },
  );
  const at = o.at ?? kit.clock.now();
  for (const place of places)
    await run(
      kit.env.DB,
      `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at,
         last_scan_id, due_at) VALUES (?, ?, ?, 'in', 1, ?, ?, ?, 'seed', ?)`,
      [pass.id, o.orgId ?? kit.org.id, place, at, at, at, o.dueAt ?? null],
    );
  return pass;
}

export const presenceOf = (passId: string, place: string) =>
  all<{ state: string; due_at: number | null }>(
    kit.env.DB,
    'SELECT state, due_at FROM scan_presence WHERE pass_id = ? AND scope = ?',
    [passId, place],
  );

export const DISPLAY_TPL = {
  actions: [CHECK_IN],
  display: { v: 1, holder: '{{inputs.memberName}}' },
} as const;

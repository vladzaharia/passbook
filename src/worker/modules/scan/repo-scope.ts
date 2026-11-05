import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, placeholders, stmt } from '../../platform/db.ts';
import { type ScanStaffRow, type StaffRaw, staffStatement, toStaff } from './repo-staff.ts';

type Db = D1Database;

export interface ScanEventRow {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  matchInput: string | null;
  matchValues: string | null;
  opensAt: number;
  closesAt: number;
  timeZone: string;
  capacity: number | null;
  reentry: boolean;
  note: string | null;
  updatedAt: number;
  archivedAt: number | null;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  match_input: string | null;
  match_values: string | null;
  opens_at: number;
  closes_at: number;
  time_zone: string;
  capacity: number | null;
  reentry: number;
  note: string | null;
  updated_at: number;
  archived_at: number | null;
}

const EVENT_SQL = `SELECT id, org_id, mode, name, match_input, match_values, opens_at, closes_at, time_zone,
            capacity, reentry, note, updated_at, archived_at
     FROM scan_events WHERE id = ? AND org_id = ?`;

const toEvent = (r: Raw): ScanEventRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  matchInput: r.match_input,
  matchValues: r.match_values,
  opensAt: r.opens_at,
  closesAt: r.closes_at,
  timeZone: r.time_zone,
  capacity: r.capacity,
  reentry: r.reentry === 1,
  note: r.note,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});

/** Reads the guard needs to build a ScanActor. Event and scanner CRUD live in stream SC. */
export async function getEvent(db: Db, orgId: string, id: string): Promise<ScanEventRow | null> {
  const r = await first<Raw>(db, EVENT_SQL, [id, orgId]);
  return r ? toEvent(r) : null;
}

/** Live templates of the org only: a deleted template is not accepted. */
const EVENT_TEMPLATES_SQL = `SELECT et.template_id FROM scan_event_templates et
     JOIN templates t ON t.id = et.template_id AND t.org_id = ? AND t.status != 'deleted'
     WHERE et.event_id = ? ORDER BY et.template_id`;
const SCANNER_TEMPLATES_SQL = `SELECT st.template_id FROM scanner_templates st
     JOIN templates t ON t.id = st.template_id AND t.org_id = ? AND t.status != 'deleted'
     WHERE st.scanner_id = ? ORDER BY st.template_id`;

export async function eventTemplateIds(db: Db, orgId: string, eventId: string): Promise<string[]> {
  const rows = await all<{ template_id: string }>(db, EVENT_TEMPLATES_SQL, [orgId, eventId]);
  return rows.map((r) => r.template_id);
}

export interface ScannerScope {
  /** Null when the scanner has none, or it is archived or of another mode. */
  event: ScanEventRow | null;
  templateIds: string[];
  staff: ScanStaffRow | null;
}

/**
 * Everything the guard reads for a scanner after the credential checks, in one round trip: its
 * event, the live templates it accepts (the event's, else its own) and the signed-in staff row.
 */
export async function readScannerScope(
  db: Db,
  scanner: { id: string; orgId: string; mode: Mode; eventId: string | null },
  staffId: string | null,
): Promise<ScannerScope> {
  const statements = [
    stmt(db, SCANNER_TEMPLATES_SQL, [scanner.orgId, scanner.id]),
    ...(scanner.eventId
      ? [
          stmt(db, EVENT_SQL, [scanner.eventId, scanner.orgId]),
          stmt(db, EVENT_TEMPLATES_SQL, [scanner.orgId, scanner.eventId]),
        ]
      : []),
    ...(staffId ? [staffStatement(db, scanner.orgId, staffId)] : []),
  ];
  const results = await db.batch(statements);
  const rows = <T>(i: number): T[] => (results[i]?.results ?? []) as T[];
  let at = 1;
  const eventRaw = scanner.eventId ? rows<Raw>(at++)[0] : undefined;
  const eventTemplates = scanner.eventId ? rows<{ template_id: string }>(at++) : [];
  const staffRaw = staffId ? rows<StaffRaw>(at)[0] : undefined;
  const found = eventRaw ? toEvent(eventRaw) : null;
  const event = found && found.mode === scanner.mode && found.archivedAt === null ? found : null;
  const own = rows<{ template_id: string }>(0);
  return {
    event,
    templateIds: (event ? eventTemplates : own).map((r) => r.template_id),
    staff: staffRaw ? toStaff(staffRaw) : null,
  };
}

/** How many of the ids are templates of this org (deleted ones excluded). */
export async function countOrgTemplates(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM templates
     WHERE org_id = ? AND status != 'deleted' AND id IN (${placeholders(ids.length)})`,
    [orgId, ...ids],
  );
  return row?.n ?? 0;
}

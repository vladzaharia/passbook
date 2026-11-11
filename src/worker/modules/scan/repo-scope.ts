import { IdSchema, type Mode } from '../../../shared/contracts/common.ts';
import { TimeZoneSchema } from '../../../shared/contracts/scan.ts';
import { first, placeholders, stmt } from '../../platform/db.ts';
import { usableScanTemplateSql } from './repo-scope-releases.ts';
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

/** Every configured template must have an approved head or an eligible pinned legacy pass. */
const EVENT_SCOPE_TEMPLATES_SQL = `SELECT et.template_id,t.id AS scoped_template_id,
     t.org_id AS scoped_org_id,t.status AS scoped_status,
     CASE WHEN ${usableScanTemplateSql({
       templateIdSql: 't.id',
       orgIdSql: 'e.org_id',
       modeSql: 'e.mode',
       providerSql: "'apple'",
     })} THEN t.id END AS live_template_id
     FROM scan_event_templates et
     JOIN scan_events e ON e.id=et.event_id AND e.org_id=? AND e.mode=?
     LEFT JOIN templates t ON t.id=et.template_id AND (t.org_id=e.org_id OR t.org_id IS NULL) AND t.status!='deleted'
     WHERE et.event_id=? ORDER BY et.template_id`;
const SCANNER_TEMPLATES_SQL = `SELECT st.template_id,t.id AS scoped_template_id,
     t.org_id AS scoped_org_id,t.status AS scoped_status,
     CASE WHEN ${usableScanTemplateSql({
       templateIdSql: 't.id',
       orgIdSql: 's.org_id',
       modeSql: 's.mode',
       providerSql: "'apple'",
     })} THEN t.id END AS live_template_id
     FROM scanner_templates st
     LEFT JOIN scanners s ON s.id=st.scanner_id AND s.org_id=? AND s.mode=?
     LEFT JOIN templates t ON t.id=st.template_id AND (t.org_id=s.org_id OR t.org_id IS NULL) AND t.status!='deleted'
     WHERE st.scanner_id=? ORDER BY st.template_id`;

/** Match data is stored as JSON and must retain the same constraints as a created event. */
function validEventMatch(event: ScanEventRow): boolean {
  if (event.matchInput === null && event.matchValues === null) return true;
  if (
    !event.matchInput ||
    event.matchInput.length > 64 ||
    /["\\]/.test(event.matchInput) ||
    event.matchValues === null
  )
    return false;
  try {
    const values: unknown = JSON.parse(event.matchValues);
    return (
      Array.isArray(values) &&
      values.length > 0 &&
      values.length <= 20 &&
      values.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 120)
    );
  } catch {
    return false;
  }
}

type ScopedTemplate = {
  template_id: string;
  scoped_template_id: string | null;
  scoped_org_id: string | null;
  scoped_status: string | null;
  live_template_id: string | null;
};
type EventScope = { event: ScanEventRow; templateIds: string[] };

function eventScopeOf(
  mode: Mode,
  raw: Raw | undefined,
  templates: ScopedTemplate[],
  allowUnavailableRelease = false,
): EventScope | null {
  if (!raw || raw.mode !== mode || raw.archived_at !== null) return null;
  const event = toEvent(raw);
  if (
    event.id.length === 0 ||
    event.id.length > 64 ||
    !TimeZoneSchema.safeParse(event.timeZone).success ||
    !Number.isSafeInteger(event.opensAt) ||
    event.opensAt < 0 ||
    !Number.isSafeInteger(event.closesAt) ||
    event.closesAt <= event.opensAt ||
    (event.capacity !== null && (!Number.isSafeInteger(event.capacity) || event.capacity <= 0)) ||
    !validEventMatch(event) ||
    templates.length === 0 ||
    templates.length > 20 ||
    templates.some(
      (row) =>
        (allowUnavailableRelease ? row.scoped_template_id : row.live_template_id) === null ||
        row.template_id.length === 0 ||
        row.template_id.length > 64,
    )
  )
    return null;
  return { event, templateIds: templates.map((row) => row.template_id) };
}

/** Resolve all of an event's scope, or deny it if any part is unusable. */
export async function readValidEventScope(
  db: Db,
  orgId: string,
  mode: Mode,
  eventId: string,
): Promise<EventScope | null> {
  if (!IdSchema.safeParse(eventId).success) return null;
  const results = await db.batch([
    stmt(db, EVENT_SQL, [eventId, orgId]),
    stmt(db, EVENT_SCOPE_TEMPLATES_SQL, [orgId, mode, eventId]),
  ]);
  return eventScopeOf(
    mode,
    results[0]?.results?.[0] as Raw | undefined,
    (results[1]?.results ?? []) as ScopedTemplate[],
  );
}

/** Original configured assignment, including valid links whose current release is unavailable. */
export interface ScannerAssignmentSnapshot {
  scannerId: string;
  orgId: string;
  mode: Mode;
  eventId: string | null;
  event: ScanEventRow | null;
  templateIds: string[];
  templateRows: string;
  structurallyValid: boolean;
}

export interface ScannerScope {
  /** Null when the scanner has no event, or its pinned event cannot be used. */
  event: ScanEventRow | null;
  templateIds: string[];
  /** A configured event or template list must not be treated as accept-all. */
  restricted: boolean;
  /** False when a configured event or template list cannot be resolved safely. */
  valid: boolean;
  /** Internal history/receipt evidence, never a grant to read or act on a pass. */
  assignment: ScannerAssignmentSnapshot | null;
  staff: ScanStaffRow | null;
}

/** Decode a scanner's original scope and staff rows from a shared D1 observation. */
function scannerScopeOf(
  scanner: { id: string; orgId: string; mode: Mode; eventId: string | null },
  staffRaw: StaffRaw | null | undefined,
  templates: ScopedTemplate[],
  eventRaw: Raw | undefined,
): ScannerScope {
  if (scanner.eventId !== null && !IdSchema.safeParse(scanner.eventId).success) {
    return {
      event: null,
      templateIds: [],
      restricted: true,
      valid: false,
      assignment: null,
      staff: staffRaw ? toStaff(staffRaw) : null,
    };
  }
  const hasEvent = scanner.eventId !== null;
  const invalidTemplates =
    !hasEvent &&
    (templates.length > 20 ||
      templates.some(
        (row) =>
          row.live_template_id === null ||
          row.template_id.length === 0 ||
          row.template_id.length > 64,
      ));
  const invalidAssignment =
    !hasEvent &&
    (templates.length > 20 ||
      templates.some(
        (row) =>
          row.scoped_template_id === null ||
          row.template_id.length === 0 ||
          row.template_id.length > 64,
      ));
  const scope = hasEvent ? eventScopeOf(scanner.mode, eventRaw, templates) : null;
  const observedScope = hasEvent
    ? (scope ?? eventScopeOf(scanner.mode, eventRaw, templates, true))
    : null;
  const templateIds = scope?.templateIds ?? [];
  if (!hasEvent && !invalidTemplates)
    for (const row of templates)
      if (row.live_template_id !== null) templateIds.push(row.template_id);
  return {
    event: scope?.event ?? null,
    templateIds,
    restricted: hasEvent || templates.length > 0,
    valid: hasEvent ? scope !== null : !invalidTemplates,
    assignment: {
      scannerId: scanner.id,
      orgId: scanner.orgId,
      mode: scanner.mode,
      eventId: scanner.eventId,
      event: observedScope?.event ?? null,
      templateIds: hasEvent
        ? (observedScope?.templateIds ?? [])
        : templates.map((row) => row.template_id),
      templateRows: JSON.stringify(
        templates.map((row) => [
          row.template_id,
          row.scoped_template_id,
          row.scoped_org_id,
          row.scoped_status,
        ]),
      ),
      structurallyValid: hasEvent ? observedScope !== null : !invalidAssignment,
    },
    staff: staffRaw ? toStaff(staffRaw) : null,
  };
}

/** Read a scanner's event, templates and staff in one D1 round trip. */
export async function readScannerScope(
  db: Db,
  scanner: { id: string; orgId: string; mode: Mode; eventId: string | null },
  staffId: string | null,
): Promise<ScannerScope> {
  if (scanner.eventId !== null && !IdSchema.safeParse(scanner.eventId).success) {
    const staffRaw = staffId
      ? await staffStatement(db, scanner.orgId, staffId).first<StaffRaw>()
      : null;
    return scannerScopeOf(scanner, staffRaw, [], undefined);
  }
  const hasEvent = scanner.eventId !== null;
  const statements = [
    hasEvent
      ? stmt(db, EVENT_SCOPE_TEMPLATES_SQL, [scanner.orgId, scanner.mode, scanner.eventId])
      : stmt(db, SCANNER_TEMPLATES_SQL, [scanner.orgId, scanner.mode, scanner.id]),
    ...(hasEvent ? [stmt(db, EVENT_SQL, [scanner.eventId, scanner.orgId])] : []),
    ...(staffId ? [staffStatement(db, scanner.orgId, staffId)] : []),
  ];
  const results = await db.batch(statements);
  const rows = <T>(i: number): T[] => (results[i]?.results ?? []) as T[];
  const templates = rows<ScopedTemplate>(0);
  let at = 1;
  const eventRaw = hasEvent ? rows<Raw>(at++)[0] : undefined;
  const staffRaw = staffId ? rows<StaffRaw>(at)[0] : undefined;
  return scannerScopeOf(scanner, staffRaw, templates, eventRaw);
}

/** How many ids are usable templates of this org. */
export async function countOrgTemplates(
  db: Db,
  orgId: string,
  mode: Mode,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM templates t CROSS JOIN (SELECT ? AS org_id, ? AS mode) scope
     WHERE (t.org_id=scope.org_id OR t.org_id IS NULL) AND t.status != 'deleted'
       AND t.id IN (${placeholders(ids.length)})
       AND ${usableScanTemplateSql({
         templateIdSql: 't.id',
         orgIdSql: 'scope.org_id',
         modeSql: 'scope.mode',
         providerSql: "'apple'",
       })}`,
    [orgId, mode, ...ids],
  );
  return row?.n ?? 0;
}

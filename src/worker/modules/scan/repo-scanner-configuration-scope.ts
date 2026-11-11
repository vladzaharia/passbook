import type { Mode } from '../../../shared/contracts/common.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { packedPredicate } from './repo-action-authority.ts';
import type { ConsoleScannerRow } from './repo-scanners.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import {
  captureTemplateStamps,
  type SessionLegacyStamp,
  type SessionReleaseStamp,
  sessionTemplateStampsPredicate,
  usableScanTemplateSql,
} from './repo-scope-releases.ts';

type Db = D1Database;

type Accepts = { eventId: string } | { templateIds: string[] } | null | undefined;

interface ConfigurationTemplateStamps {
  releases: SessionReleaseStamp[];
  legacy: SessionLegacyStamp[];
}

/** What the configuration operation actually observed, including unusable restrictions. */
export interface ConfigurationScopeSnapshot {
  orgId: string;
  mode: Mode;
  eventIds: string;
  events: string;
  eventTemplates: string;
  scannerId: string | null;
  scannerTemplates: string;
  templateIds: string;
  /** Tuples of requested id, actual id, tenant, and status; missing ids retain nulls. */
  templateRows: string;
  stamps: ConfigurationTemplateStamps[];
  unusable: string[];
}

const eventRowsSql = `(SELECT json_group_array(json_array(id,org_id,mode,name,match_input,match_values,
    opens_at,closes_at,time_zone,capacity,reentry,note,archived_at,updated_at))
  FROM (SELECT * FROM scan_events WHERE org_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id))`;
const eventTemplatesSql = `(SELECT json_group_array(json_array(event_id,template_id))
  FROM (SELECT et.event_id,et.template_id FROM scan_event_templates et
    JOIN scan_events e ON e.id=et.event_id AND e.org_id=?
    WHERE e.id IN (SELECT value FROM json_each(?)) ORDER BY et.event_id,et.template_id))`;
const scannerTemplatesSql = `(SELECT json_group_array(template_id)
  FROM (SELECT template_id FROM scanner_templates WHERE scanner_id=? ORDER BY template_id))`;
const templateRowsSql = `(SELECT json_group_array(json_array(requested_id,actual_id,org_id,status))
  FROM (SELECT requested.value AS requested_id,t.id AS actual_id,t.org_id,t.status
    FROM json_each(?) requested LEFT JOIN templates t ON t.id=requested.value ORDER BY requested.value))`;

function addAccepts(raw: unknown, events: Set<string>, templates: Set<string>): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as { eventId?: unknown; templateIds?: unknown };
  if (typeof value.eventId === 'string') events.add(value.eventId);
  if (Array.isArray(value.templateIds))
    for (const id of value.templateIds) if (typeof id === 'string') templates.add(id);
}

function addStoredAccepts(raw: string | null, events: Set<string>, templates: Set<string>): void {
  if (raw === null) return;
  try {
    addAccepts(JSON.parse(raw), events, templates);
  } catch {
    // Preserve a malformed stored scope without treating it as unrestricted.
  }
}

function addCheckIn(raw: string, events: Set<string>): void {
  try {
    const eventId: unknown = JSON.parse(raw)?.checkIn?.eventId;
    if (typeof eventId === 'string') events.add(eventId);
  } catch {
    // The stored settings themselves are fenced by the configuration claim.
  }
}

/**
 * Capture before evaluating proposed/current scope. Invalid existing restrictions remain
 * invalid, rather than being reconstructed as an unrestricted scope on a metadata edit.
 */
export async function captureConfigurationScope(
  db: Db,
  orgId: string,
  mode: Mode,
  options: {
    scanner?: ConsoleScannerRow | null;
    session?: ScanningSessionRow | null;
    accepts?: Accepts;
    checkInEventId?: string | null;
  },
): Promise<ConfigurationScopeSnapshot> {
  const events = new Set<string>();
  const templates = new Set<string>();
  const scanner = options.scanner;
  const session = options.session;
  if (scanner && scanner.eventId !== null) events.add(scanner.eventId);
  if (scanner) addCheckIn(scanner.settings, events);
  if (session) {
    addStoredAccepts(session.accepts, events, templates);
    addCheckIn(session.settings, events);
  }
  addAccepts(options.accepts, events, templates);
  if (options.checkInEventId) events.add(options.checkInEventId);
  const eventIds = JSON.stringify([...events].sort());
  const scannerId = scanner?.id ?? null;
  const raw = await first<{ events: string; event_templates: string; scanner_templates: string }>(
    db,
    `SELECT ${eventRowsSql} AS events, ${eventTemplatesSql} AS event_templates,
      ${scannerTemplatesSql} AS scanner_templates`,
    [orgId, eventIds, orgId, eventIds, scannerId],
  );
  if (!raw) throw new Error('Unable to capture scanner scope.');
  for (const id of JSON.parse(raw.scanner_templates) as string[]) templates.add(id);
  for (const [, id] of JSON.parse(raw.event_templates) as [string, string][]) templates.add(id);
  const ids = [...templates].sort();
  const templateIds = JSON.stringify(ids);
  const structural = await first<{ templates: string }>(
    db,
    `SELECT ${templateRowsSql} AS templates`,
    [templateIds],
  );
  if (!structural) throw new Error('Unable to capture scanner template structure.');
  const stamps: ConfigurationTemplateStamps[] = [];
  const unusable: string[] = [];
  for (let at = 0; at < ids.length; at += 20) {
    const chunk = ids.slice(at, at + 20);
    const captured = await captureTemplateStamps(db, orgId, mode, chunk);
    if (captured) {
      stamps.push(captured);
      continue;
    }
    // A corrupt/deleted member must not hide the other members' evaluated heads.
    const valid: ConfigurationTemplateStamps = { releases: [], legacy: [] };
    for (const id of chunk) {
      const item = await captureTemplateStamps(db, orgId, mode, [id]);
      if (item) {
        valid.releases.push(...item.releases);
        valid.legacy.push(...item.legacy);
      } else {
        unusable.push(id);
      }
    }
    if (valid.releases.length || valid.legacy.length) stamps.push(valid);
  }
  return {
    orgId,
    mode,
    eventIds,
    events: raw.events,
    eventTemplates: raw.event_templates,
    scannerId,
    scannerTemplates: raw.scanner_templates,
    templateIds,
    templateRows: structural.templates,
    stamps,
    unusable,
  };
}

/** Exact event revisions and configured template links, independent of release usability. */
export function configurationScopeRowsPredicate(
  snapshot: Readonly<ConfigurationScopeSnapshot>,
  orgId: string,
  mode: Mode,
): { sql: string; params: SqlValue[] } {
  if (snapshot.orgId !== orgId || snapshot.mode !== mode) return { sql: '0', params: [] };
  return {
    sql: [
      `${eventRowsSql}=?/* scan-ephemeral-scope-event-rows */`,
      `${eventTemplatesSql}=?/* scan-ephemeral-scope-event-templates */`,
      `${scannerTemplatesSql}=?/* scan-ephemeral-scope-scanner-templates */`,
    ].join(' AND '),
    params: [
      orgId,
      snapshot.eventIds,
      snapshot.events,
      orgId,
      snapshot.eventIds,
      snapshot.eventTemplates,
      snapshot.scannerId,
      snapshot.scannerTemplates,
    ],
  };
}

/** Exact template existence, ownership, and status, without a release-availability requirement. */
export function configurationScopeTemplatesPredicate(
  snapshot: Readonly<ConfigurationScopeSnapshot>,
  orgId: string,
  mode: Mode,
): { sql: string; params: SqlValue[] } {
  if (snapshot.orgId !== orgId || snapshot.mode !== mode) return { sql: '0', params: [] };
  return {
    sql: `${templateRowsSql}=?/* scan-ephemeral-scope-template-rows */`,
    params: [snapshot.templateIds, snapshot.templateRows],
  };
}

export function configurationScopePredicate(
  snapshot: ConfigurationScopeSnapshot | undefined,
  orgId: string,
  mode: Mode,
): { sql: string; params: SqlValue[] } {
  if (!snapshot) return { sql: '1', params: [] };
  if (snapshot.orgId !== orgId || snapshot.mode !== mode) return { sql: '0', params: [] };
  const rows = configurationScopeRowsPredicate(snapshot, orgId, mode);
  const templates = configurationScopeTemplatesPredicate(snapshot, orgId, mode);
  const sql = [`(${rows.sql})`, `(${templates.sql})`];
  const params: SqlValue[] = [...rows.params, ...templates.params];
  for (const stamps of snapshot.stamps) {
    const predicate = sessionTemplateStampsPredicate(
      stamps.releases,
      stamps.legacy,
      'config_scope.org_id',
      'config_scope.mode',
    );
    sql.push(`EXISTS (SELECT 1 FROM (SELECT ? AS org_id, ? AS mode) config_scope
      WHERE ${predicate.sql})`);
    params.push(orgId, mode, ...predicate.params);
  }
  if (snapshot.unusable.length) {
    sql.push(`NOT EXISTS (SELECT 1 FROM (SELECT ? AS org_id, ? AS mode) invalid_scope
      JOIN json_each(?) invalid
      JOIN templates invalid_t ON invalid_t.id=invalid.value
        AND (invalid_t.org_id=invalid_scope.org_id OR invalid_t.org_id IS NULL)
        AND invalid_t.status!='deleted'
      WHERE ${usableScanTemplateSql({
        templateIdSql: 'invalid_t.id',
        orgIdSql: 'invalid_scope.org_id',
        modeSql: 'invalid_scope.mode',
        providerSql: "'apple'",
      })})`);
    params.push(orgId, mode, JSON.stringify(snapshot.unusable));
  }
  return packedPredicate(sql.join(' AND '), params);
}

export const hasScannerTemplates = async (db: Db, scannerId: string): Promise<boolean> =>
  !!(await first<{ present: number }>(
    db,
    'SELECT 1 AS present FROM scanner_templates WHERE scanner_id=? LIMIT 1',
    [scannerId],
  ));

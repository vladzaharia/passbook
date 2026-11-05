import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, placeholders } from '../../platform/db.ts';

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

/** Reads the guard needs to build a ScanActor. Event and scanner CRUD live in stream SC. */
export async function getEvent(db: Db, orgId: string, id: string): Promise<ScanEventRow | null> {
  const r = await first<Raw>(
    db,
    `SELECT id, org_id, mode, name, match_input, match_values, opens_at, closes_at, time_zone,
            capacity, reentry, note, updated_at, archived_at
     FROM scan_events WHERE id = ? AND org_id = ?`,
    [id, orgId],
  );
  return r
    ? {
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
      }
    : null;
}

export async function eventTemplateIds(db: Db, eventId: string): Promise<string[]> {
  const rows = await all<{ template_id: string }>(
    db,
    'SELECT template_id FROM scan_event_templates WHERE event_id = ? ORDER BY template_id',
    [eventId],
  );
  return rows.map((r) => r.template_id);
}

export async function scannerTemplateIds(db: Db, scannerId: string): Promise<string[]> {
  const rows = await all<{ template_id: string }>(
    db,
    'SELECT template_id FROM scanner_templates WHERE scanner_id = ? ORDER BY template_id',
    [scannerId],
  );
  return rows.map((r) => r.template_id);
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

import type { ConnectionFileFormat } from '../../../shared/contracts/connection-files.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { gt } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ConnectionActor, connectionGrant, connectionIs } from './repo-grants.ts';

export type FileState = 'draft' | 'pending' | 'current' | 'superseded' | 'expired' | 'discarded';

export interface FileRow {
  id: string;
  orgId: string;
  connectionId: string | null;
  revision: number | null;
  state: FileState;
  name: string;
  format: ConnectionFileFormat;
  sheet: string | null;
  recordsPointer: string | null;
  idPointer: string | null;
  columnLabels: string[];
  bytes: number;
  sha256: string;
  rows: number;
  columns: number;
  pages: number;
  skippedNoId: number | null;
  skippedDuplicate: number | null;
  diff: {
    added: number;
    changed: number;
    removed: number;
    examples: { added: string[]; changed: string[]; removed: string[] };
  } | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  supersededAt: number | null;
}

interface Sql {
  id: string;
  org_id: string;
  connection_id: string | null;
  revision: number | null;
  state: FileState;
  name: string;
  format: ConnectionFileFormat;
  sheet: string | null;
  records_pointer: string | null;
  id_pointer: string | null;
  column_labels: string;
  bytes: number;
  sha256: string;
  rows: number;
  columns: number;
  pages: number;
  skipped_no_id: number | null;
  skipped_duplicate: number | null;
  diff_added: number | null;
  diff_changed: number | null;
  diff_removed: number | null;
  diff_examples: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  superseded_at: number | null;
}

function toRow(r: Sql): FileRow {
  return {
    id: r.id,
    orgId: r.org_id,
    connectionId: r.connection_id,
    revision: r.revision,
    state: r.state,
    name: r.name,
    format: r.format,
    sheet: r.sheet,
    recordsPointer: r.records_pointer,
    idPointer: r.id_pointer,
    columnLabels: JSON.parse(r.column_labels) as string[],
    bytes: r.bytes,
    sha256: r.sha256,
    rows: r.rows,
    columns: r.columns,
    pages: r.pages,
    skippedNoId: r.skipped_no_id,
    skippedDuplicate: r.skipped_duplicate,
    diff:
      r.diff_added === null || r.diff_examples === null
        ? null
        : {
            added: r.diff_added,
            changed: r.diff_changed ?? 0,
            removed: r.diff_removed ?? 0,
            examples: JSON.parse(r.diff_examples) as NonNullable<FileRow['diff']>['examples'],
          },
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    supersededAt: r.superseded_at,
  };
}

/** The org a file belongs to, for a by-id route that must authorize before it reads anything else. */
export async function fileOrgOf(db: D1Database, id: string): Promise<string | null> {
  const r = await first<{ org_id: string }>(
    db,
    'SELECT org_id FROM connection_files WHERE id = ?',
    [id],
  );
  return r?.org_id ?? null;
}

export async function getFile(db: D1Database, orgId: string, id: string): Promise<FileRow | null> {
  const r = await first<Sql>(db, 'SELECT * FROM connection_files WHERE id = ? AND org_id = ?', [
    id,
    orgId,
  ]);
  return r ? toRow(r) : null;
}

/** Revisions of one connection, newest first. */
export async function listRevisions(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<FileRow[]> {
  const rows = await all<Sql>(
    db,
    `SELECT * FROM connection_files WHERE org_id = ? AND connection_id = ? AND revision IS NOT NULL
     ORDER BY revision DESC`,
    [orgId, connectionId],
  );
  return rows.map(toRow);
}

export async function fileInState(
  db: D1Database,
  orgId: string,
  connectionId: string,
  state: 'current' | 'pending',
): Promise<FileRow | null> {
  const r = await first<Sql>(
    db,
    'SELECT * FROM connection_files WHERE org_id = ? AND connection_id = ? AND state = ?',
    [orgId, connectionId, state],
  );
  return r ? toRow(r) : null;
}

/** Superseded revisions still held, newest first. */
export async function supersededOf(
  db: D1Database,
  orgId: string,
  connectionId: string,
  limit: number,
): Promise<FileRow[]> {
  const rows = await all<Sql>(
    db,
    `SELECT * FROM connection_files WHERE org_id = ? AND connection_id = ? AND state = 'superseded'
     ORDER BY revision DESC LIMIT ?`,
    [orgId, connectionId, limit],
  );
  return rows.map(toRow);
}

export async function nextRevision(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<number> {
  const r = await first<{ n: number | null }>(
    db,
    'SELECT MAX(revision) AS n FROM connection_files WHERE org_id = ? AND connection_id = ?',
    [orgId, connectionId],
  );
  return (r?.n ?? 0) + 1;
}

export async function openDrafts(db: D1Database, orgId: string, now: number): Promise<number> {
  const r = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM connection_files WHERE org_id = ? AND state = 'draft' AND expires_at > ?`,
    [orgId, now],
  );
  return r?.n ?? 0;
}

/** The connection's stored sync cursor, for "Applied": `fu1:<fileId>:-:done:0` names the file the last run finished. */
export async function cursorOf(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<string | null> {
  const r = await first<{ cursor: string | null }>(
    db,
    'SELECT cursor FROM connections WHERE id = ? AND org_id = ?',
    [connectionId, orgId],
  );
  return r?.cursor ?? null;
}

export async function userNames(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await all<{ id: string; name: string | null }>(
    db,
    `SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );
  for (const r of rows) if (r.name) out.set(r.id, r.name);
  return out;
}

/** Every file id of a connection, for the object cleanup after its rows are deleted. */
export async function fileIdsOf(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    'SELECT id FROM connection_files WHERE org_id = ? AND connection_id = ?',
    [orgId, connectionId],
  );
  return rows.map((r) => r.id);
}

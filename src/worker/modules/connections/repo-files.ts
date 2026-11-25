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

const COLUMNS = [
  'id',
  'connection_id',
  'revision',
  'state',
  'name',
  'format',
  'sheet',
  'records_pointer',
  'id_pointer',
  'column_labels',
  'bytes',
  'sha256',
  'rows',
  'columns',
  'pages',
  'skipped_no_id',
  'skipped_duplicate',
  'diff_added',
  'diff_changed',
  'diff_removed',
  'diff_examples',
  'created_by',
  'created_at',
  'expires_at',
];

function values(r: FileRow) {
  return [
    r.id,
    r.connectionId,
    r.revision,
    r.state,
    r.name,
    r.format,
    r.sheet,
    r.recordsPointer,
    r.idPointer,
    JSON.stringify(r.columnLabels),
    r.bytes,
    r.sha256,
    r.rows,
    r.columns,
    r.pages,
    r.skippedNoId,
    r.skippedDuplicate,
    r.diff?.added ?? null,
    r.diff?.changed ?? null,
    r.diff?.removed ?? null,
    r.diff ? JSON.stringify(r.diff.examples) : null,
    r.createdBy,
    r.createdAt,
    r.expiresAt,
  ];
}

/** A new draft or pending revision. `org_id` comes from the grant. */
export async function insertDraft(
  ctx: ServiceContext,
  actor: ConnectionActor,
  row: FileRow,
): Promise<void> {
  const g = connectionGrant(ctx, actor, 'file_upload', [], row.id);
  g.insertSelect('connection_files', COLUMNS, values(row));
  await g.commit();
}

/** Re-reads a draft with another sheet or records path. Only a live draft changes. */
export async function updateDraft(
  ctx: ServiceContext,
  actor: ConnectionActor,
  row: FileRow,
  now: number,
): Promise<void> {
  const g = connectionGrant(
    ctx,
    actor,
    'file_update',
    [
      exactlyOne(
        'connection_files',
        { id: row.id, state: 'draft', expires_at: gt(now) },
        undefined,
        'stale',
      ),
    ],
    row.id,
  );
  g.update('connection_files', {
    where: { id: row.id },
    set: {
      sheet: row.sheet,
      records_pointer: row.recordsPointer,
      column_labels: JSON.stringify(row.columnLabels),
      bytes: row.bytes,
      sha256: row.sha256,
      rows: row.rows,
      columns: row.columns,
    },
    require: 'one',
  });
  await g.commit();
}

/** Ends an unbound draft or an unapplied pending revision: the row stays `discarded` until retention. */
export async function discardFile(
  ctx: ServiceContext,
  actor: ConnectionActor,
  row: FileRow,
  now: number,
): Promise<void> {
  const g = connectionGrant(
    ctx,
    actor,
    'file_discard',
    [exactlyOne('connection_files', { id: row.id, state: row.state }, undefined, 'stale')],
    row.id,
  );
  g.update('connection_files', {
    where: { id: row.id, state: row.state },
    set: { state: 'discarded', expires_at: now },
    require: 'one',
  });
  await g.commit();
}

export interface Bind {
  fileId: string;
  idPointer: string;
  pages: number;
  skippedNoId: number;
  skippedDuplicate: number;
  now: number;
}

/**
 * Inside the create grant: the draft becomes revision 1 of the new connection. The check and the write both
 * hold only while the draft is still a draft, unexpired, in the grant's org.
 */
export function bindChecks(b: Bind) {
  return [
    exactlyOne(
      'connection_files',
      { id: b.fileId, state: 'draft', expires_at: gt(b.now) },
      undefined,
      'stale',
    ),
  ];
}

export function addBind(g: Grant, connectionId: string, b: Bind): GrantedStatement {
  return g.update('connection_files', {
    where: { id: b.fileId, state: 'draft', expires_at: gt(b.now) },
    set: {
      connection_id: connectionId,
      revision: 1,
      state: 'current',
      id_pointer: b.idPointer,
      pages: b.pages,
      skipped_no_id: b.skippedNoId,
      skipped_duplicate: b.skippedDuplicate,
      expires_at: null,
    },
    require: 'one',
    returning: ['id'],
  });
}

/** Closes any older pending revision and inserts the new one, so there is never more than one. */
export async function insertPending(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  row: FileRow,
  now: number,
): Promise<void> {
  const g = connectionGrant(
    ctx,
    actor,
    'file_upload',
    [connectionIs({ id: connectionId })],
    row.id,
  );
  g.update('connection_files', {
    where: { connection_id: connectionId, state: 'pending' },
    set: { state: 'discarded', expires_at: now },
  });
  g.insertSelect('connection_files', COLUMNS, values(row));
  await g.commit();
}

/** One batch: the current revision is superseded and the pending one becomes current, or neither. */
export async function promotePending(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  file: FileRow,
  now: number,
): Promise<void> {
  const g = connectionGrant(
    ctx,
    actor,
    'file_apply',
    [
      connectionIs({ id: connectionId, enabled: true }),
      exactlyOne(
        'connection_files',
        { id: file.id, connection_id: connectionId, state: 'pending', expires_at: gt(now) },
        undefined,
        'stale',
      ),
    ],
    file.id,
  );
  g.update('connection_files', {
    where: { connection_id: connectionId, state: 'current' },
    set: { state: 'superseded', superseded_at: now },
  });
  g.update('connection_files', {
    where: { id: file.id, state: 'pending' },
    set: { state: 'current', expires_at: null },
    require: 'one',
  });
  await g.commit();
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

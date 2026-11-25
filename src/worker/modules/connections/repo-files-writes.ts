import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { gt } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { FileRow } from './repo-files.ts';
import { type ConnectionActor, connectionGrant, connectionIs } from './repo-grants.ts';

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
  'bind_id',
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
    r.bindId,
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
  /** The subprefix the pages were written under. */
  bindId: string;
  /** What prepareBind read: the commit holds only while the draft still has them. */
  sheet: string | null;
  recordsPointer: string | null;
  sha256: string;
  pages: number;
  skippedNoId: number;
  skippedDuplicate: number;
  now: number;
}

/**
 * Inside the create grant: the draft becomes revision 1 of the new connection. The check and the write both
 * hold only while the draft is still a draft, unexpired, in the grant's org.
 */
const pinned = (b: Bind) => ({
  sheet: b.sheet,
  records_pointer: b.recordsPointer,
  sha256: b.sha256,
});

export function bindChecks(b: Bind) {
  return [
    exactlyOne(
      'connection_files',
      { id: b.fileId, state: 'draft', expires_at: gt(b.now), ...pinned(b) },
      undefined,
      'stale',
    ),
  ];
}

export function addBind(g: Grant, connectionId: string, b: Bind): GrantedStatement {
  return g.update('connection_files', {
    where: { id: b.fileId, state: 'draft', expires_at: gt(b.now), ...pinned(b) },
    set: {
      bind_id: b.bindId,
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

/**
 * Closes any older pending revision and inserts the new one, so there is never more than one. Returns the ids
 * it actually discarded: one that became current meanwhile is not among them, and its objects must stay.
 */
export async function insertPending(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  row: FileRow,
  now: number,
): Promise<string[]> {
  const g = connectionGrant(
    ctx,
    actor,
    'file_upload',
    [connectionIs({ id: connectionId })],
    row.id,
  );
  const discard = g.update('connection_files', {
    where: { connection_id: connectionId, state: 'pending' },
    set: { state: 'discarded', expires_at: now },
    returning: ['id'],
  });
  g.insertSelect('connection_files', COLUMNS, values(row));
  const results = await g.commit();
  return (results[g.indexOf(discard)]?.results ?? []).map((r) => (r as { id: string }).id);
}

/** One batch: the current revision is superseded and the pending one becomes current, or neither. */
export async function promotePending(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  file: FileRow,
  now: number,
  generation: number,
): Promise<void> {
  const g = connectionGrant(
    ctx,
    actor,
    'file_apply',
    [
      connectionIs({ id: connectionId, enabled: true, generation }),
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
  // A run listing the old file ends stale; the run Apply starts next lists this one from its start.
  g.update('connections', { set: { generation: generation + 1 }, where: { id: connectionId } });
  await g.commit();
}

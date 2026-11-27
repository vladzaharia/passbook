import { PASS_NOTE_CAP } from '../../../shared/contracts/scan-history.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { SqlValue } from '../../platform/db.ts';
import { first } from '../../platform/db.ts';
import { type ScanReadAuthority, scanAuthorizedStmt, scanRead } from './repo-read-authority.ts';

export interface NoteRow {
  id: string;
  created_at: number;
  body: string;
  author_name: string;
  author_staff_id: string | null;
  scanner_id: string | null;
  edited_at: number | null;
}

const COLUMNS = 'created_at, body, author_name, author_staff_id, scanner_id, edited_at';

export interface NoteScope {
  orgId: string;
  mode: string;
  passId: string;
  generation: number;
}

export interface NotesQuery {
  passId: string;
  templateId: string;
  /** The pass's current credential generation: a note of another holder is never read. */
  generation: number;
  /** Only notes at or after this time. */
  since?: number;
  /** Only notes before this (time, id), the history cursor. */
  before?: { at: number; id: string };
  limit: number;
}

/**
 * A pass's notes, newest first, under the actor's fence and the pass's own tenant, template and
 * life: a deleted, removed or quarantined pass has no notes to read.
 */
function notesStmt(db: D1Database, auth: ScanReadAuthority, q: NotesQuery): D1PreparedStatement {
  const params: SqlValue[] = [q.passId, q.templateId, q.generation];
  let cursor = '';
  if (q.since !== undefined) {
    cursor += ' AND n.created_at >= ?';
    params.push(q.since);
  }
  if (q.before) {
    cursor += ' AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))';
    params.push(q.before.at, q.before.at, q.before.id);
  }
  params.push(q.limit);
  return scanRead(
    db,
    auth,
    `SELECT n.id, n.created_at, n.body, n.author_name, n.author_staff_id, n.scanner_id, n.edited_at
     FROM ${auth.rows}pass_notes n
     JOIN passes p ON p.id = n.pass_id AND p.org_id = n.org_id AND p.mode = n.mode
       AND p.credential_generation = n.credential_generation
     WHERE ${auth.present} AND ${auth.tenantOnce('n', 'pass_notes')}
       AND n.pass_id = ? AND p.template_id = ? AND n.credential_generation = ?
       AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0${cursor}
     ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    params,
  );
}

/** The fence and the notes in one batch: unauthorized is told apart from empty. */
export async function readNotes(
  db: D1Database,
  auth: ScanReadAuthority,
  q: NotesQuery,
): Promise<{ authorized: boolean; rows: NoteRow[] }> {
  const [authorized, page] = await db.batch([scanAuthorizedStmt(db, auth), notesStmt(db, auth, q)]);
  const ok = (authorized?.results[0] as { authorized: number } | undefined)?.authorized === 1;
  return { authorized: ok, rows: ok ? ((page?.results ?? []) as unknown as NoteRow[]) : [] };
}

/** The note a retried tap already wrote, inside the same tenant and pass. */
export function noteByKey(db: D1Database, scope: NoteScope, key: string): Promise<NoteRow | null> {
  return first<NoteRow>(
    db,
    `SELECT id, ${COLUMNS} FROM pass_notes
     WHERE org_id = ? AND mode = ? AND pass_id = ? AND credential_generation = ? AND idempotency_key = ?`,
    [scope.orgId, scope.mode, scope.passId, scope.generation, key],
  );
}

export function noteById(db: D1Database, scope: NoteScope, id: string): Promise<NoteRow | null> {
  return first<NoteRow>(
    db,
    `SELECT id, ${COLUMNS} FROM pass_notes
     WHERE org_id = ? AND mode = ? AND pass_id = ? AND credential_generation = ? AND id = ?`,
    [scope.orgId, scope.mode, scope.passId, scope.generation, id],
  );
}

/** The pass holds fewer notes than it may. Evaluated in the insert, so two taps cannot both pass. */
export const underCap = (passId: string): GrantCond => ({
  render: (b) =>
    `(SELECT count(*) FROM pass_notes cap WHERE cap.pass_id = ${b.bind(passId)}) < ${PASS_NOTE_CAP}`,
});

/** This device wrote fewer than `limit` notes on the pass since `since`: one device cannot fill a pass in minutes. */
export const deviceUnderCap = (
  passId: string,
  scannerId: string,
  since: number,
  limit: number,
): GrantCond => ({
  render: (b) =>
    `(SELECT count(*) FROM pass_notes dev WHERE dev.pass_id = ${b.bind(passId)} AND dev.scanner_id = ${b.bind(scannerId)} AND dev.created_at >= ${b.bind(since)}) < ${limit}`,
});

export async function deviceNoteCount(
  db: D1Database,
  passId: string,
  scannerId: string,
  since: number,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM pass_notes WHERE pass_id = ? AND scanner_id = ? AND created_at >= ?',
    [passId, scannerId, since],
  );
  return row?.n ?? 0;
}

import {
  PASS_IMPORT_PROBLEMS,
  type PassImportDto,
} from '../../../shared/contracts/pass-imports.ts';
import { jobGrant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import type { DeferredStarter } from './repo-bulk-principal.ts';
import type { Scope } from './repo-import-commit.ts';
import { type ImportRow, importGrant } from './repo-imports.ts';

/** Imports an undo may start from: a run that applied rows and has ended. */
export const UNDOABLE = ['done', 'failed', 'stale'];
/** `reverted`: 0 untouched, 1 undo running (held mail is cancelled), 2 undo finished. */
export const UNDO_RUNNING = 1;
export const UNDO_DONE = 2;

const TABLES = ['pass_imports', 'pass_import_rows'] as const;
const CODES = { stale: 'IMPORT_STATE', lineage: 'IMPORT_NOT_FOUND' };

/** Asks for the undo in the caller's own grant: only an ended, untouched import, once. */
export async function beginUndo(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  s: { starter: DeferredStarter; cancelled: number },
): Promise<void> {
  const g = importGrant(ctx, authority, id, { state: inList(UNDOABLE), reverted: 0 });
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: {
      reverted: UNDO_RUNNING,
      starter: JSON.stringify(s.starter),
      undo_cancelled: s.cancelled,
    },
  });
  g.audit({
    at: ctx.clock.now(),
    orgId: authority.orgId,
    actorType: authority.kind === 'session' ? 'user' : 'api_key',
    actorId: authority.kind === 'session' ? authority.userId : authority.keyId,
    action: 'pass_import.undo',
    targetType: 'pass_import',
    targetId: id,
    requestId: ctx.requestId,
    ipPrefix: null,
    detail: JSON.stringify({ importId: id, emailsCancelled: s.cancelled }),
  });
  await g.commit();
}

/** The undo's workflow did not start: back to untouched, so held mail is not lost for nothing. */
export async function revertUndo(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
): Promise<void> {
  const g = importGrant(ctx, authority, id, { reverted: UNDO_RUNNING });
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: { reverted: 0, starter: null, undo_cancelled: 0 },
  });
  await g.commit();
}

/** A write of the undo's own rows, by the workflow, only while the undo is running. */
function undoGrant(ctx: ServiceContext, s: Scope, purpose: string) {
  return jobGrant(ctx, {
    purpose,
    job: 'pass-import',
    orgId: s.orgId,
    mode: s.mode,
    target: s.importId,
    tables: TABLES,
    codes: CODES,
    checks: [
      exactlyOne('pass_imports', { id: s.importId, reverted: UNDO_RUNNING }, undefined, 'stale'),
    ],
  });
}

/** Marks rows handled by the undo; `code` says why a pass was kept, null when it was removed or restored. */
export async function markUndone(
  ctx: ServiceContext,
  s: Scope,
  rows: readonly { row: number; code: string | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  const g = undoGrant(ctx, s, 'org_mode.job.pass_import.undo');
  const at = ctx.clock.now();
  for (const r of rows)
    g.joined('pass_import_rows', {
      where: { import_id: s.importId, row_no: r.row, undone_at: null },
      set: { undone_at: at, undo_code: r.code },
    });
  await g.commit();
}

export async function finishUndo(ctx: ServiceContext, s: Scope): Promise<void> {
  const g = undoGrant(ctx, s, 'org_mode.job.pass_import.undo_finish');
  g.update('pass_imports', {
    where: { id: s.importId },
    require: 'one',
    set: { reverted: UNDO_DONE },
  });
  await g.commit();
}

export interface UndoRow {
  row_no: number;
  result: 'created' | 'updated';
  pass_id: string;
  before: string | null;
  written_version: number | null;
}

/** The next rows the undo has not handled, in file order. */
export function undoRows(db: D1Database, importId: string, limit: number): Promise<UndoRow[]> {
  return all<UndoRow>(
    db,
    `SELECT row_no, result, pass_id, before, written_version FROM pass_import_rows
     WHERE import_id = ? AND result IN ('created', 'updated') AND pass_id IS NOT NULL
       AND undone_at IS NULL ORDER BY row_no LIMIT ?`,
    [importId, limit],
  );
}

export interface UndoCounts {
  removed: number;
  restored: number;
  keptTotal: number;
  kept: { passId: string; code: string }[];
}

export async function undoCounts(
  db: D1Database,
  importId: string,
  keptLimit: number,
): Promise<UndoCounts> {
  const done = await all<{ result: string; kept: number; n: number }>(
    db,
    `SELECT result, undo_code IS NOT NULL AS kept, count(*) AS n FROM pass_import_rows
     WHERE import_id = ? AND undone_at IS NOT NULL GROUP BY result, kept`,
    [importId],
  );
  const n = (result: string, kept: number) =>
    done.find((d) => d.result === result && d.kept === kept)?.n ?? 0;
  const kept = await all<{ pass_id: string; undo_code: string }>(
    db,
    `SELECT pass_id, undo_code FROM pass_import_rows
     WHERE import_id = ? AND undo_code IS NOT NULL ORDER BY row_no LIMIT ?`,
    [importId, keptLimit],
  );
  return {
    removed: n('created', 0),
    restored: n('updated', 0),
    keptTotal: n('created', 1) + n('updated', 1),
    kept: kept.map((k) => ({ passId: k.pass_id, code: k.undo_code })),
  };
}

/** Held mails an undo cancels: created rows with an address that no mail has claimed yet. */
export async function pendingMail(db: D1Database, importId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM pass_import_rows
     WHERE import_id = ? AND result = 'created' AND emailed = 0 AND holder_email IS NOT NULL`,
    [importId],
  );
  return row?.n ?? 0;
}

/** The undo as the API shows it: counts come from the rows, so a poll mid-run is exact. */
export async function undoResultOf(
  db: D1Database,
  imp: Pick<ImportRow, 'id' | 'reverted' | 'undo_cancelled'>,
): Promise<NonNullable<PassImportDto['undo']>> {
  return {
    state: imp.reverted === UNDO_DONE ? 'done' : 'running',
    ...(await undoCounts(db, imp.id, PASS_IMPORT_PROBLEMS)),
    emailsCancelled: imp.undo_cancelled,
  };
}

import { jobGrant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Scope } from './repo-import-commit.ts';

const TABLES = ['pass_imports', 'pass_import_rows'] as const;
const CODES = { stale: 'IMPORT_STATE', lineage: 'IMPORT_NOT_FOUND' };

/** A write of the held mail's own rows, by the workflow: only while the import is done and not undone. */
function heldGrant(ctx: ServiceContext, s: Scope) {
  return jobGrant(ctx, {
    purpose: 'org_mode.job.pass_import.release',
    job: 'pass-import',
    orgId: s.orgId,
    mode: s.mode,
    target: s.importId,
    tables: TABLES,
    codes: CODES,
    checks: [
      exactlyOne(
        'pass_imports',
        { id: s.importId, state: 'done', reverted: 0 },
        undefined,
        'stale',
      ),
    ],
  });
}

/** Claims rows for mail in one guarded write, marking them pending until they are sent or refused. */
export async function claimHeld(
  ctx: ServiceContext,
  s: Scope,
  rows: readonly number[],
): Promise<number[]> {
  if (rows.length === 0) return [];
  const g = heldGrant(ctx, s);
  const claim = g.joined('pass_import_rows', {
    where: { import_id: s.importId, result: 'created', emailed: 0, row_no: inList([...rows]) },
    set: { mail_pending_at: ctx.clock.now() },
    returning: ['row_no'],
  });
  const results = await g.commit();
  const won = results[g.indexOf(claim)]?.results as { row_no: number }[] | undefined;
  return (won ?? []).map((r) => r.row_no);
}

/** Settles a page: sent rows are emailed, refused rows go back as not emailed (email-rest can send them). */
export async function settleHeld(
  ctx: ServiceContext,
  s: Scope,
  settled: { sent: readonly number[]; refused: readonly number[] },
  notEmailed: number,
): Promise<void> {
  const g = heldGrant(ctx, s);
  if (settled.sent.length > 0)
    g.joined('pass_import_rows', {
      where: { import_id: s.importId, emailed: 0, row_no: inList([...settled.sent]) },
      set: { emailed: 1, mail_pending_at: null },
    });
  if (settled.refused.length > 0)
    g.joined('pass_import_rows', {
      where: { import_id: s.importId, emailed: 0, row_no: inList([...settled.refused]) },
      set: { mail_pending_at: null },
    });
  g.update('pass_imports', {
    where: { id: s.importId },
    require: 'one',
    set: { not_emailed: notEmailed },
  });
  await g.commit();
}

export interface HeldRow {
  row_no: number;
  pass_id: string;
  holder_email: string;
  mail_pending_at: number | null;
}

/** Created rows with an address and no mail yet, after `after`; a pending row is a claim a step left behind. */
export function heldCandidates(
  db: D1Database,
  importId: string,
  after: number,
  limit: number,
): Promise<HeldRow[]> {
  return all<HeldRow>(
    db,
    `SELECT row_no, pass_id, holder_email, mail_pending_at FROM pass_import_rows
     WHERE import_id = ? AND result = 'created' AND emailed = 0 AND holder_email IS NOT NULL
       AND row_no > ? ORDER BY row_no LIMIT ?`,
    [importId, after, limit],
  );
}

/** A mail for the pass was queued since `since`: a pending row's step got that far. */
export async function mailQueuedSince(
  db: D1Database,
  passId: string,
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      "SELECT 1 AS n FROM outbox WHERE pass_id = ? AND kind = 'email' AND created_at >= ? LIMIT 1",
      [passId, since],
    )) !== null
  );
}

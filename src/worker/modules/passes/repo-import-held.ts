import { jobGrant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { inList } from '../../platform/authority-expr.ts';
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

/** Claims rows for mail in one guarded write; a repeat or an undo in between wins nothing. */
export async function claimHeld(
  ctx: ServiceContext,
  s: Scope,
  rows: readonly number[],
): Promise<number[]> {
  if (rows.length === 0) return [];
  const g = heldGrant(ctx, s);
  const claim = g.joined('pass_import_rows', {
    where: { import_id: s.importId, result: 'created', emailed: 0, row_no: inList([...rows]) },
    set: { emailed: 1 },
    returning: ['row_no'],
  });
  const results = await g.commit();
  const won = results[g.indexOf(claim)]?.results as { row_no: number }[] | undefined;
  return (won ?? []).map((r) => r.row_no);
}

/** Gives claimed rows back when their mail was refused, and records what is still not emailed. */
export async function settleHeld(
  ctx: ServiceContext,
  s: Scope,
  refused: readonly number[],
  notEmailed: number,
): Promise<void> {
  const g = heldGrant(ctx, s);
  if (refused.length > 0)
    g.joined('pass_import_rows', {
      where: { import_id: s.importId, emailed: 1, row_no: inList([...refused]) },
      set: { emailed: 0 },
    });
  g.update('pass_imports', {
    where: { id: s.importId },
    require: 'one',
    set: { not_emailed: notEmailed },
  });
  await g.commit();
}

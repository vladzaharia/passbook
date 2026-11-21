import { inList, lt, orNull } from '../../platform/authority-expr.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { UNDO_DONE } from './repo-import-undo.ts';
import { importGrant } from './repo-imports.ts';

const ENDED = ['done', 'failed', 'stale', 'expired'];

export interface EmailRow {
  row_no: number;
  pass_id: string;
  holder_email: string;
  mail_pending_at: number | null;
}

/** Created rows of live passes with an address and no mail yet, in file order after `after`. */
export function emailCandidates(
  db: D1Database,
  importId: string,
  orgId: string,
  after: number,
  limit: number,
  /** A claim older than this was left by a step that died. */
  staleBefore: number,
): Promise<EmailRow[]> {
  return all<EmailRow>(
    db,
    `SELECT r.row_no, r.pass_id, r.holder_email, r.mail_pending_at FROM pass_import_rows r JOIN passes p ON p.id = r.pass_id
     WHERE r.import_id = ? AND r.result = 'created' AND r.emailed = 0 AND r.holder_email IS NOT NULL
       AND p.org_id = ? AND p.removed_at IS NULL AND (r.mail_pending_at IS NULL OR r.mail_pending_at < ?) AND r.row_no > ?
     ORDER BY r.row_no LIMIT ?`,
    [importId, orgId, staleBefore, after, limit],
  );
}

/**
 * Marks rows emailed in one guarded write and returns the ones this call won: a repeat or a concurrent
 * call finds `emailed = 1` and gets nothing, so nobody is mailed twice.
 */
export async function claimRows(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  rows: readonly number[],
  staleBefore: number,
): Promise<number[]> {
  if (rows.length === 0) return [];
  const g = importGrant(ctx, authority, id, {
    state: inList(ENDED),
    reverted: inList([0, UNDO_DONE]),
  });
  const claim = g.joined('pass_import_rows', {
    where: {
      import_id: id,
      result: 'created',
      emailed: 0,
      mail_pending_at: orNull(lt(staleBefore)),
      row_no: inList([...rows]),
    },
    set: { emailed: 1 },
    returning: ['row_no'],
  });
  const results = await g.commit();
  const won = results[g.indexOf(claim)]?.results as { row_no: number }[] | undefined;
  return (won ?? []).map((r) => r.row_no);
}

/** Gives claimed rows back when their mail was not queued. */
export async function releaseRows(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  rows: readonly number[],
): Promise<void> {
  if (rows.length === 0) return;
  const g = importGrant(ctx, authority, id, { state: inList(ENDED) });
  g.joined('pass_import_rows', {
    where: { import_id: id, emailed: 1, row_no: inList([...rows]) },
    set: { emailed: 0 },
  });
  await g.commit();
}

/** The not-emailed counter and the audit row of a call that sent mail, in one batch. */
export async function recordEmailRest(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  notEmailed: number,
  detail: { sent: number; skipped: number; alreadyQueued: number },
): Promise<void> {
  const g = importGrant(ctx, authority, id, { state: inList(ENDED) });
  g.update('pass_imports', { where: { id }, require: 'one', set: { not_emailed: notEmailed } });
  g.audit({
    at: ctx.clock.now(),
    orgId: authority.orgId,
    actorType: authority.kind === 'session' ? 'user' : 'api_key',
    actorId: authority.kind === 'session' ? authority.userId : authority.keyId,
    action: 'pass_import.email_rest',
    targetType: 'pass_import',
    targetId: id,
    requestId: ctx.requestId,
    ipPrefix: null,
    detail: JSON.stringify({ importId: id, ...detail }),
  });
  await g.commit();
}

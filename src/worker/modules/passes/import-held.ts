import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { StarterSchema } from '../delivery/issuance-context.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import type { ImportRunParams } from './import-apply.ts';
import { getPassForWrite } from './pass-access.ts';
import { reissuePrincipalValid, starterFits } from './repo-bulk-principal.ts';
import { progressOf, type Scope } from './repo-import-commit.ts';
import { claimHeld, heldCandidates, mailQueuedSince, settleHeld } from './repo-import-held.ts';
import { getImport } from './repo-imports.ts';

/** Mails a step queues: each is a few D1 calls, and a step must stay well under the subrequest limit. */
export const HELD_PAGE = 10;

/**
 * The held mail after its wait: the next rows of the import's created passes that no mail has claimed,
 * while the import is still `done` and not undone and its starter still holds. Rows are claimed before
 * they are mailed, so a repeated step mails nobody twice; a refused mail gives its row back as not emailed.
 */
export async function releaseHeldPage(
  ctx: ServiceContext,
  params: ImportRunParams,
  after: number,
): Promise<{ next: number | null }> {
  const db = ctx.env.DB;
  const s: Scope = params;
  const imp = await getImport(db, params.orgId, params.mode, params.importId);
  if (imp?.state !== 'done' || imp.reverted !== 0 || imp.email_hold_ms === null)
    return { next: null };
  const starter = StarterSchema.safeParse(JSON.parse(imp.starter ?? 'null'));
  if (
    !starter.success ||
    !starterFits(starter.data, imp.org_id, imp.mode) ||
    !(await reissuePrincipalValid(db, imp.org_id, starter.data, ctx.clock.now()))
  ) {
    ctx.log.warn('pass_import.hold_starter_revoked', {
      code: 'IMPORT_STARTER_REVOKED',
      importId: imp.id,
    });
    return { next: null };
  }
  try {
    const rows = await heldCandidates(db, imp.id, after, HELD_PAGE + 1);
    const page = rows.slice(0, HELD_PAGE);
    const won = new Set(
      await claimHeld(
        ctx,
        s,
        page.map((r) => r.row_no),
      ),
    );
    const scope = { orgId: imp.org_id, mode: imp.mode, principal: 'session' as const };
    const sent: number[] = [];
    const refused: number[] = [];
    for (const row of page) {
      if (!won.has(row.row_no)) continue;
      try {
        // A step that died after queuing the mail left the row pending: do not mail it twice.
        if (
          row.mail_pending_at !== null &&
          (await mailQueuedSince(db, row.pass_id, row.mail_pending_at))
        ) {
          sent.push(row.row_no);
          continue;
        }
        const pass = await getPassForWrite(db, row.pass_id, scope);
        // Only the address the row was imported with, while the pass is live: a changed address is refused, never mailed.
        if (
          pass.status !== 'active' ||
          pass.removedAt !== null ||
          !pass.holderEmail ||
          pass.holderEmail.toLowerCase() !== row.holder_email.toLowerCase()
        ) {
          refused.push(row.row_no);
          continue;
        }
        await enqueuePassEmail(ctx, {
          passId: row.pass_id,
          to: pass.holderEmail,
          attach: false,
          expected: pass,
        });
        sent.push(row.row_no);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        refused.push(row.row_no);
        ctx.log.warn('pass_import.held_refused', { importId: imp.id, code: error.code });
      }
    }
    await settleHeld(ctx, s, { sent, refused }, (await progressOf(db, imp.id)).notEmailed);
    const last = page[page.length - 1];
    return { next: rows.length > HELD_PAGE && last ? last.row_no : null };
  } catch (error) {
    // An undo (or a suspended org) won the race for the claim: nothing more to send, and not a failure.
    if (
      error instanceof AppError &&
      ['IMPORT_STATE', 'IMPORT_NOT_FOUND', 'ORG_ACCESS_CHANGED'].includes(error.code)
    ) {
      ctx.log.info('pass_import.held_stopped', { importId: imp.id, code: error.code });
      return { next: null };
    }
    throw error;
  }
}

import type { z } from 'zod';
import type { PassImportEmailRestResultSchema } from '../../../shared/contracts/pass-imports.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { requireImport } from './import-service.ts';
import { resendEmail } from './pass-service-delivery.ts';
import { progressOf } from './repo-import-commit.ts';
import { claimRows, emailCandidates, recordEmailRest, releaseRows } from './repo-import-email.ts';
import { mailQueuedSince } from './repo-import-held.ts';
import { UNDO_RUNNING } from './repo-import-undo.ts';
import type { Actor } from './service.ts';

type Result = z.infer<typeof PassImportEmailRestResultSchema>;

/** Rows per call; the client loops on `nextCursor`. */
export const EMAIL_PAGE = 50;
/** A held-mail claim this old was left by a step that died. */
const STALE_CLAIM_MS = 10 * 60_000;
const ENDED = ['done', 'failed', 'stale', 'expired'];

/**
 * Sends now the mail of the passes an import created that went out without it (past the day's cap at
 * commit, or mail off). During a hold it sends the held mail ahead of the wait.
 * Rows are claimed (`emailed = 1`) in a guarded write before any mail is queued, and given back if the mail
 * is refused, so a repeat or a double click mails nobody twice. The caps are the normal ones: the org's 500 a
 * day and 3 an hour per holder are enforced when each mail is queued, and a refused row is counted as skipped.
 */
export async function emailRest(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  id: string,
  cursor: string | null,
): Promise<Result> {
  const imp = await requireImport(ctx, authority, id);
  if (imp.state === 'committing') throw new ConflictError('This import is running.', 'IMPORT_BUSY');
  if (imp.reverted === UNDO_RUNNING)
    throw new ConflictError('This import is being undone.', 'IMPORT_UNDO_RUNNING');
  if (imp.committed_at === null || !ENDED.includes(imp.state))
    throw new ConflictError('This import created no passes.', 'IMPORT_STATE');
  const after = Number(cursor ?? 0);
  const staleBefore = ctx.clock.now() - STALE_CLAIM_MS;
  const rows = await emailCandidates(
    ctx.env.DB,
    imp.id,
    imp.org_id,
    Number.isSafeInteger(after) ? after : 0,
    EMAIL_PAGE + 1,
    staleBefore,
  );
  const page = rows.slice(0, EMAIL_PAGE);
  const won = new Set(
    await claimRows(
      ctx,
      authority,
      imp.id,
      page.map((r) => r.row_no),
      staleBefore,
    ),
  );
  const scope = {
    orgId: imp.org_id,
    mode: imp.mode,
    principal: authority.kind === 'session' ? ('session' as const) : ('api_key' as const),
  };
  const sentRows: number[] = [];
  /** Rows a dead held-mail step had already queued: marked emailed, not mailed again, not counted as sent. */
  const alreadyQueued: number[] = [];
  const refused: number[] = [];
  for (const row of page) {
    if (!won.has(row.row_no)) continue;
    try {
      // A held claim a step left behind: its mail may already be queued, and is never queued twice.
      const queued =
        row.mail_pending_at !== null &&
        (await mailQueuedSince(ctx.env.DB, row.pass_id, row.mail_pending_at));
      if (queued) alreadyQueued.push(row.row_no);
      else {
        await resendEmail(ctx, actor, row.pass_id, {}, scope, authority);
        sentRows.push(row.row_no);
      }
    } catch (error) {
      if (!(error instanceof AppError)) {
        // Not an answer of the mail rules: give back every claimed row that was not sent, then fail.
        await releaseRows(
          ctx,
          authority,
          imp.id,
          [...won].filter((n) => !sentRows.includes(n) && !alreadyQueued.includes(n)),
        );
        throw error;
      }
      refused.push(row.row_no);
      ctx.log.warn('pass_import.email_rest_refused', {
        orgId: imp.org_id,
        importId: imp.id,
        code: error.code,
      });
    }
  }
  await releaseRows(ctx, authority, imp.id, refused);
  const sent = sentRows.length;
  if (sent > 0 || alreadyQueued.length > 0) {
    const { notEmailed } = await progressOf(ctx.env.DB, imp.id);
    await recordEmailRest(ctx, authority, imp.id, notEmailed, {
      sent,
      skipped: refused.length,
      alreadyQueued: alreadyQueued.length,
    });
  }
  const last = page[page.length - 1];
  return {
    sent,
    skipped: refused.length,
    alreadyQueued: alreadyQueued.length,
    nextCursor: rows.length > EMAIL_PAGE && last ? String(last.row_no) : null,
  };
}

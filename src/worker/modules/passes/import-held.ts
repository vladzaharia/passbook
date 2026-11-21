import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { StarterSchema } from '../delivery/issuance-context.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import type { ImportRunParams } from './import-apply.ts';
import { getPassForWrite } from './pass-access.ts';
import { reissuePrincipalValid, starterFits } from './repo-bulk-principal.ts';
import { progressOf, type Scope } from './repo-import-commit.ts';
import { emailCandidates } from './repo-import-email.ts';
import { claimHeld, settleHeld } from './repo-import-held.ts';
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
  const rows = await emailCandidates(db, imp.id, imp.org_id, after, HELD_PAGE + 1);
  const page = rows.slice(0, HELD_PAGE);
  const won = new Set(
    await claimHeld(
      ctx,
      s,
      page.map((r) => r.row_no),
    ),
  );
  const scope = { orgId: imp.org_id, mode: imp.mode, principal: 'session' as const };
  const refused: number[] = [];
  for (const row of page) {
    if (!won.has(row.row_no)) continue;
    try {
      const pass = await getPassForWrite(db, row.pass_id, scope);
      await enqueuePassEmail(ctx, {
        passId: row.pass_id,
        to: row.holder_email,
        attach: false,
        expected: pass,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      refused.push(row.row_no);
      ctx.log.warn('pass_import.held_refused', { importId: imp.id, code: error.code });
    }
  }
  await settleHeld(ctx, s, refused, (await progressOf(db, imp.id)).notEmailed);
  const last = page[page.length - 1];
  return { next: rows.length > HELD_PAGE && last ? last.row_no : null };
}

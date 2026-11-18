import type { z } from 'zod';
import type { PassImportRemoveResultSchema } from '../../../shared/contracts/pass-imports.ts';
import { AppError, ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { requireImport } from './import-service.ts';
import { removePass } from './remove.ts';
import {
  type CreatedPass,
  createdPasses,
  createdRows,
  recordRemoval,
  removedCount,
} from './repo-import-results.ts';
import type { Actor } from './service.ts';

type RemoveResult = z.infer<typeof PassImportRemoveResultSchema>;

/** Passes per call; the client loops on `nextCursor`. */
export const REMOVE_PAGE = 50;
const ENDED = ['done', 'failed', 'stale', 'expired'];

/** Why a pass is no longer the one the import made, or null when it still is. */
function changeOf(pass: CreatedPass, mode: string): string | null {
  if (pass.mode !== mode || pass.changed === 1) return 'IMPORT_PASS_CHANGED';
  return pass.scanned === 1 ? 'IMPORT_PASS_SCANNED' : null;
}

/**
 * Removes the passes this import created, 50 rows a call after `cursor` (a row number), through the normal
 * pass removal under the caller's session. A pass someone edited or scanned since is skipped and listed;
 * a pass already removed or deleted is not counted again, so a repeated call changes nothing. The caller
 * must be a session: an API key never reaches this.
 */
export async function removeCreated(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  id: string,
  cursor: string | null,
): Promise<RemoveResult> {
  if (authority.kind !== 'session')
    throw new ForbiddenError('Removing needs a signed-in user.', 'SESSION_REQUIRED');
  const imp = await requireImport(ctx, authority, id);
  if (imp.state === 'committing') throw new ConflictError('This import is running.', 'IMPORT_BUSY');
  if (imp.committed_at === null || !ENDED.includes(imp.state))
    throw new ConflictError('This import created no passes.', 'IMPORT_STATE');
  const after = Number(cursor ?? 0);
  const rows = await createdRows(
    ctx.env.DB,
    imp.id,
    Number.isSafeInteger(after) ? after : 0,
    REMOVE_PAGE + 1,
  );
  const page = rows.slice(0, REMOVE_PAGE);
  const current = new Map(
    (
      await createdPasses(
        ctx.env.DB,
        imp.org_id,
        page.map((r) => r.pass_id),
      )
    ).map((p) => [p.id, p]),
  );
  const scope = { orgId: imp.org_id, mode: imp.mode, principal: 'session' as const };
  let removed = 0;
  const skipped: RemoveResult['skipped'] = [];
  for (const row of page) {
    const pass = current.get(row.pass_id);
    if (!pass || pass.removed_at !== null) continue;
    const why = changeOf(pass, imp.mode);
    if (why) {
      skipped.push({ passId: pass.id, code: why });
      continue;
    }
    try {
      await removePass(ctx, actor, pass.id, {}, scope, authority);
      removed++;
    } catch (error) {
      // One refused pass (it changed between the read and the claim) must not hide the rest.
      if (!(error instanceof AppError)) throw error;
      skipped.push({ passId: pass.id, code: error.code });
    }
  }
  if (removed > 0 || skipped.length > 0) {
    await recordRemoval(ctx, authority, imp.id, await removedCount(ctx.env.DB, imp.id), {
      removed,
      skipped: skipped.length,
    });
    ctx.log.info('pass_import.remove_created', {
      orgId: imp.org_id,
      importId: imp.id,
      removed,
      skipped: skipped.length,
    });
  }
  const last = page[page.length - 1];
  return {
    removed,
    skipped,
    nextCursor: rows.length > REMOVE_PAGE && last ? String(last.row_no) : null,
  };
}

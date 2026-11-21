import type { Personalization } from '../../../passkit/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { StarterSchema } from '../delivery/issuance-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import type { ImportRunParams } from './import-apply.ts';
import { publishPass } from './publish.ts';
import { removePass } from './remove.ts';
import type { Pass } from './repo.ts';
import {
  type DeferredStarter,
  reissuePrincipalCheck,
  reissuePrincipalValid,
  starterFits,
} from './repo-bulk-principal.ts';
import type { Scope } from './repo-import-commit.ts';
import { type CreatedPass, createdPasses } from './repo-import-results.ts';
import { markUndone, UNDO_RUNNING, type UndoRow, undoRows } from './repo-import-undo.ts';
import { getImport, type ImportRow } from './repo-imports.ts';
import type { Actor } from './service.ts';

/** Rows a step takes: each is a removal or a publish, several D1 calls and an R2 write. */
export const UNDO_CHUNK = 5;

const actorOf = (starter: DeferredStarter): Actor =>
  starter.kind === 'membership'
    ? { type: 'user', id: starter.userId }
    : { type: 'api_key', id: starter.keyId };

/** Why a created pass is no longer the one the import made, or null when it still is. */
function changeOf(pass: CreatedPass, mode: string): string | null {
  if (pass.mode !== mode || pass.changed === 1) return 'IMPORT_PASS_CHANGED';
  return pass.scanned === 1 ? 'IMPORT_PASS_SCANNED' : null;
}

interface Earlier {
  personalization: Personalization;
  fieldSources: Pass['fieldSources'];
}

function earlierOf(json: string | null): Earlier | null {
  try {
    const v = json === null ? null : (JSON.parse(json) as Earlier);
    return v && typeof v.personalization === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function restoreRow(
  ctx: ServiceContext,
  imp: ImportRow,
  starter: DeferredStarter,
  row: UndoRow,
  pass: CreatedPass,
): Promise<void> {
  const earlier = earlierOf(row.before);
  // The guard: the pass must still be at the version the import wrote, and the import must have kept its inputs.
  if (!earlier || row.written_version === null || pass.version !== row.written_version)
    throw new AppError('IMPORT_PASS_CHANGED', 409, 'The pass changed since the import.');
  await publishPass(ctx, {
    orgScope: { orgId: imp.org_id, mode: imp.mode, principal: 'session' },
    passId: row.pass_id,
    cause: starter.kind === 'membership' ? 'admin' : 'api',
    actor: actorOf(starter),
    dispatch: false,
    extraChecks: [reissuePrincipalCheck(imp.org_id, starter, ctx.clock.now())],
    mutate: (current) => {
      if (
        current.orgId !== imp.org_id ||
        current.mode !== imp.mode ||
        current.templateId !== imp.template_id ||
        current.connectionId !== null ||
        current.removedAt !== null ||
        current.version !== row.written_version
      )
        throw new AppError('IMPORT_PASS_CHANGED', 409, 'The pass changed since the import.');
      return { personalization: earlier.personalization, fieldSources: earlier.fieldSources };
    },
  });
}

/**
 * Undoes the next rows: a created pass is removed unless it was edited or scanned since; an updated pass
 * gets its earlier inputs back only while it is still at the version the import wrote. Anything else is
 * kept and listed. A pass already removed is left as it is. Both writes re-prove the starter and fence on
 * the pass version inside their own write, so an edit or a change run that lands after the read keeps the pass.
 */
export async function undoChunk(
  ctx: ServiceContext,
  params: ImportRunParams,
): Promise<{ more: boolean; revoked?: true }> {
  const db = ctx.env.DB;
  const s: Scope = params;
  const imp = await getImport(db, params.orgId, params.mode, params.importId);
  if (imp?.reverted !== UNDO_RUNNING) return { more: false };
  const parsed = StarterSchema.safeParse(JSON.parse(imp.starter ?? 'null'));
  const starter: DeferredStarter | null = parsed.success ? parsed.data : null;
  if (
    !starter ||
    !starterFits(starter, imp.org_id, imp.mode) ||
    !(await reissuePrincipalValid(db, imp.org_id, starter, ctx.clock.now()))
  ) {
    ctx.log.warn('pass_import.undo_starter_revoked', {
      code: 'IMPORT_STARTER_REVOKED',
      importId: imp.id,
    });
    return { more: false, revoked: true };
  }
  const rows = await undoRows(db, imp.id, UNDO_CHUNK);
  if (rows.length === 0) return { more: false };
  const current = new Map(
    (
      await createdPasses(
        db,
        imp.org_id,
        rows.map((r) => r.pass_id),
      )
    ).map((p) => [p.id, p]),
  );
  const scope = { orgId: imp.org_id, mode: imp.mode, principal: 'session' as const };
  const done: { row: number; code: string | null }[] = [];
  let restored = 0;
  for (const row of rows) {
    const pass = current.get(row.pass_id);
    // Gone or already removed: nothing to undo.
    if (!pass || (pass.removed_at !== null && row.result === 'created')) {
      done.push({ row: row.row_no, code: null });
      continue;
    }
    try {
      if (row.result === 'created') {
        const why = changeOf(pass, imp.mode);
        if (why) throw new AppError(why, 409, 'The pass changed since the import.');
        await removePass(ctx, actorOf(starter), pass.id, {}, scope, undefined, {
          version: pass.version,
          noScans: true,
        });
      } else {
        await restoreRow(ctx, imp, starter, row, pass);
        restored++;
      }
      done.push({ row: row.row_no, code: null });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (!(await reissuePrincipalValid(db, imp.org_id, starter, ctx.clock.now())))
        return { more: false, revoked: true };
      done.push({ row: row.row_no, code: error.code.slice(0, 64) });
    }
  }
  await markUndone(ctx, s, done);
  if (restored > 0) await dispatchSafely(ctx);
  return { more: (await undoRows(db, imp.id, 1)).length > 0 };
}

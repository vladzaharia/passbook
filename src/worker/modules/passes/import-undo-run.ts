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
import {
  markUndone,
  noScansCheck,
  UNDO_RUNNING,
  UNDOABLE,
  type UndoRow,
  undoRows,
} from './repo-import-undo.ts';
import { getImport, type ImportRow } from './repo-imports.ts';
import { getPass } from './repo-read-pass.ts';
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

const changed = () =>
  new AppError('IMPORT_PASS_CHANGED', 409, 'The pass changed since the import.');

/** True when the pass holds the earlier inputs one version after the import's: an earlier try of this restore. */
async function restoredAlready(
  ctx: ServiceContext,
  imp: ImportRow,
  row: UndoRow,
  earlier: Earlier,
): Promise<boolean> {
  const now = await getPass(ctx.env.DB, row.pass_id, imp.org_id);
  return (
    now !== null &&
    row.written_version !== null &&
    now.version === row.written_version + 1 &&
    JSON.stringify(now.personalization, Object.keys(now.personalization).sort()) ===
      JSON.stringify(earlier.personalization, Object.keys(earlier.personalization).sort())
  );
}

async function restoreRow(
  ctx: ServiceContext,
  imp: ImportRow,
  starter: DeferredStarter,
  row: UndoRow,
  pass: CreatedPass,
): Promise<void> {
  const earlier = earlierOf(row.before);
  // An import from before undo existed kept no earlier inputs: say so, it is not a later edit.
  if (!earlier || row.written_version === null)
    throw new AppError('IMPORT_UNDO_NO_BEFORE', 409, 'The import kept no earlier values.');
  if (pass.removed_at !== null)
    throw new AppError('IMPORT_PASS_GONE', 409, 'The pass was removed.');
  if (pass.version !== row.written_version) {
    if (await restoredAlready(ctx, imp, row, earlier)) return;
    throw changed();
  }
  await publishPass(ctx, {
    orgScope: { orgId: imp.org_id, mode: imp.mode, principal: 'session' },
    passId: row.pass_id,
    cause: starter.kind === 'membership' ? 'admin' : 'api',
    actor: actorOf(starter),
    dispatch: false,
    // An undo is silent: the template's change messages do not fire.
    notify: false,
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
        throw changed();
      return { personalization: earlier.personalization, fieldSources: earlier.fieldSources };
    },
  });
}

/**
 * Undoes the next rows: a created pass is removed unless it was edited or scanned since; an updated pass
 * gets its earlier inputs back only while it is still at the version the import wrote. Anything else is
 * kept and listed. A pass already removed or deleted is listed as gone. The restore re-proves the starter
 * and fences on the pass version inside its publish; the removal forwards the same starter proof and a
 * no-scans check to its publish, which rolls the claim back when either fails, and its claim fences on
 * the version and on scans.
 */
export async function undoChunk(
  ctx: ServiceContext,
  params: ImportRunParams,
): Promise<{ more: boolean; revoked?: true }> {
  const db = ctx.env.DB;
  const s: Scope = params;
  const imp = await getImport(db, params.orgId, params.mode, params.importId);
  if (imp?.reverted !== UNDO_RUNNING || !UNDOABLE.includes(imp.state)) return { more: false };
  const parsed = StarterSchema.safeParse(JSON.parse(imp.undo_starter ?? 'null'));
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
    // Removed or deleted since: nothing to undo, and not counted as undone.
    if (!pass || (pass.removed_at !== null && row.result === 'created')) {
      done.push({ row: row.row_no, code: 'IMPORT_PASS_GONE' });
      continue;
    }
    try {
      if (row.result === 'created') {
        const why = changeOf(pass, imp.mode);
        if (why) throw new AppError(why, 409, 'The pass changed since the import.');
        await removePass(
          ctx,
          actorOf(starter),
          pass.id,
          {},
          scope,
          undefined,
          { version: pass.version, noScans: true },
          undefined,
          [reissuePrincipalCheck(imp.org_id, starter, ctx.clock.now()), noScansCheck(pass.id)],
        );
      } else {
        await restoreRow(ctx, imp, starter, row, pass);
        restored++;
      }
      done.push({ row: row.row_no, code: null });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (!(await reissuePrincipalValid(db, imp.org_id, starter, ctx.clock.now()))) {
        await markUndone(ctx, s, done);
        return { more: false, revoked: true };
      }
      // A scan that raced the removal fails the publish's check as a plain conflict: name it.
      const scanned =
        row.result === 'created' &&
        error.code !== 'IMPORT_PASS_CHANGED' &&
        (await createdPasses(db, imp.org_id, [pass.id]))[0]?.scanned === 1;
      done.push({
        row: row.row_no,
        code: (scanned ? 'IMPORT_PASS_SCANNED' : error.code).slice(0, 64),
      });
    }
  }
  await markUndone(ctx, s, done);
  if (restored > 0) await dispatchSafely(ctx);
  return { more: (await undoRows(db, imp.id, 1)).length > 0 };
}

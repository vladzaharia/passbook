import { jobGrant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { writePart } from '../../platform/authority-include.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { type EmailHold, holdRelease } from './import-email.ts';
import type { DeferredStarter } from './repo-bulk-principal.ts';
import type { Progress } from './repo-import-progress.ts';
import type { ImportRowRecord } from './repo-import-rows.ts';
import { importGrant } from './repo-imports.ts';

export { type Progress, progressOf } from './repo-import-progress.ts';

const TABLES = ['pass_imports', 'pass_import_rows'] as const;
const CODES = { stale: 'IMPORT_STATE', lineage: 'IMPORT_NOT_FOUND' };

/** Rows a workflow step takes. A create costs about 55 D1 calls, each a Workflows subrequest (limit raised in wrangler.jsonc), so 5 rows keep a step near 300. */
export const CHUNK_ROWS = 5;

export interface CommitStart {
  checkId: string;
  email: boolean;
  skipInvalid: boolean;
  starter: DeferredStarter;
  emailBudget: number;
  templateId: string;
  counts: { create: number; update: number; errors: number };
}

/**
 * ready to committing, only for the check the caller saw: a re-check in between names another `check_id`,
 * so the commit applies exactly the rows that were shown. One committing import per org, mode and template
 * is the unique index (a second commit is a unique error the service maps to `IMPORT_BUSY`).
 */
export async function beginCommit(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  s: CommitStart,
): Promise<void> {
  const now = ctx.clock.now();
  const g = importGrant(ctx, authority, id, { state: 'ready', check_id: s.checkId });
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: {
      state: 'committing',
      email: s.email ? 1 : 0,
      skip_invalid: s.skipInvalid ? 1 : 0,
      starter: JSON.stringify(s.starter),
      email_budget: s.emailBudget,
      committed_at: now,
      error_code: null,
    },
  });
  g.audit({
    at: now,
    orgId: authority.orgId,
    actorType: authority.kind === 'session' ? 'user' : 'api_key',
    actorId: authority.kind === 'session' ? authority.userId : authority.keyId,
    action: 'pass_import.commit',
    targetType: 'pass_import',
    targetId: id,
    requestId: ctx.requestId,
    ipPrefix: null,
    detail: JSON.stringify({
      importId: id,
      templateId: s.templateId,
      create: s.counts.create,
      update: s.counts.update,
      email: s.email,
      skipInvalid: s.skipInvalid,
    }),
  });
  await g.commit();
}

/** The workflow did not start: back to `ready`, so the same check can be committed again. */
export async function revertCommit(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
): Promise<void> {
  const g = importGrant(ctx, authority, id, { state: 'committing' });
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: { state: 'ready', starter: null, committed_at: null },
  });
  await g.commit();
}

/** A write of the running import's own rows, by the workflow: only while the import is still `committing`. */
function runGrant(
  ctx: ServiceContext,
  orgId: string,
  mode: 'live' | 'test',
  id: string,
  inactiveOk = false,
  purpose = 'org_mode.job.pass_import.progress',
  tables: readonly string[] = TABLES,
) {
  return jobGrant(ctx, {
    purpose,
    job: 'pass-import',
    orgId,
    mode,
    ...(inactiveOk ? { inactiveOk: true as const } : {}),
    target: id,
    tables,
    codes: CODES,
    checks: [exactlyOne('pass_imports', { id, state: 'committing' }, undefined, 'stale')],
  });
}

export interface Scope {
  orgId: string;
  mode: 'live' | 'test';
  importId: string;
}

export interface Reservation {
  row: number;
  passId: string | null;
  emailed: boolean;
}

/** Persists the ids and the email choice before any create, so a replayed step reuses both. */
export async function reserveRows(
  ctx: ServiceContext,
  s: Scope,
  rows: readonly Reservation[],
): Promise<void> {
  if (rows.length === 0) return;
  const g = runGrant(ctx, s.orgId, s.mode, s.importId);
  for (const r of rows)
    g.joined('pass_import_rows', {
      where: { import_id: s.importId, row_no: r.row, pass_id: null },
      set: { pass_id: r.passId, emailed: r.emailed ? 1 : 0 },
    });
  await g.commit();
}

export interface RowResult {
  row: number;
  state: 'done' | 'failed' | 'skipped';
  result: 'created' | 'updated' | 'unchanged' | null;
  code: string | null;
}

export async function writeRowResult(ctx: ServiceContext, s: Scope, r: RowResult): Promise<void> {
  const g = runGrant(ctx, s.orgId, s.mode, s.importId);
  g.joined('pass_import_rows', {
    where: { import_id: s.importId, row_no: r.row, state: 'planned' },
    set: { state: r.state, result: r.result, code: r.code },
  });
  await g.commit();
}

/** The plan's pass limit is reached: every create still planned is skipped with `code`; updates go on. */
export async function skipCreateRows(ctx: ServiceContext, s: Scope, code: string): Promise<void> {
  const g = runGrant(ctx, s.orgId, s.mode, s.importId);
  g.joined('pass_import_rows', {
    where: { import_id: s.importId, action: 'create', state: 'planned' },
    set: { state: 'skipped', code },
  });
  await g.commit();
}

/** Rows with errors are never applied: the commit skipped them by the caller's choice. */
export async function skipErrorRows(ctx: ServiceContext, s: Scope): Promise<void> {
  const g = runGrant(ctx, s.orgId, s.mode, s.importId);
  g.joined('pass_import_rows', {
    where: { import_id: s.importId, action: 'error', state: 'planned' },
    set: { state: 'skipped' },
  });
  await g.commit();
}

export function plannedRows(
  db: D1Database,
  importId: string,
  limit: number,
): Promise<ImportRowRecord[]> {
  return all<ImportRowRecord>(
    db,
    `SELECT row_no, action, pass_id, expected_version, external_id, holder_email, input,
       problems, state, result, code, emailed
     FROM pass_import_rows
     WHERE import_id = ? AND state = 'planned' AND action IN ('create', 'update')
     ORDER BY row_no LIMIT ?`,
    [importId, limit],
  );
}

export async function emailedCount(db: D1Database, importId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND emailed = 1',
    [importId],
  );
  return row?.n ?? 0;
}

export async function writeProgress(ctx: ServiceContext, s: Scope, p: Progress): Promise<void> {
  const g = runGrant(ctx, s.orgId, s.mode, s.importId);
  g.update('pass_imports', {
    where: { id: s.importId },
    require: 'one',
    set: {
      done: p.done,
      created: p.created,
      updated: p.updated,
      unchanged: p.unchanged,
      failed: p.failed,
      skipped: p.skipped,
      not_emailed: p.notEmailed,
    },
  });
  await g.commit();
}

/** The last write: the state, the counters and the audit row in one batch. */
export async function finishImport(
  ctx: ServiceContext,
  s: Scope,
  end: { state: 'done' | 'failed' | 'stale'; code: string | null; progress: Progress },
  /** The import's email reservation: given back in the same batch as the state change. */
  hold?: EmailHold,
): Promise<void> {
  const now = ctx.clock.now();
  // The terminal write holds while the org is suspended: a stuck import must always be freeable.
  const g = runGrant(ctx, s.orgId, s.mode, s.importId, true, 'org_mode.job.pass_import.finish', [
    'pass_imports',
    'counters',
  ]);
  const release = hold ? holdRelease(hold) : null;
  if (release)
    g.include(
      writePart(
        `INSERT INTO counters (key, window_start, count)
          SELECT ?, ?, ? WHERE {grant}
          ON CONFLICT (key, window_start) DO UPDATE SET count = count + excluded.count`,
        [release.key, release.window, -release.by],
      ),
    );
  const p = end.progress;
  g.update('pass_imports', {
    where: { id: s.importId },
    require: 'one',
    set: {
      state: end.state,
      error_code: end.code,
      finished_at: now,
      done: p.done,
      created: p.created,
      updated: p.updated,
      unchanged: p.unchanged,
      failed: p.failed,
      skipped: p.skipped,
      not_emailed: p.notEmailed,
    },
  });
  g.audit({
    at: now,
    orgId: s.orgId,
    actorType: 'system',
    actorId: null,
    action: 'pass_import.finish',
    targetType: 'pass_import',
    targetId: s.importId,
    requestId: ctx.requestId,
    ipPrefix: null,
    detail: JSON.stringify({ importId: s.importId, ...p, state: end.state, errorCode: end.code }),
  });
  await g.commit();
}

export interface StuckImport {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  check_id: string | null;
  email: number;
  email_budget: number | null;
  committed_at: number;
}

/** Imports `committing` since before `before`, oldest first, after the cursor: live ones never hide a dead one. */
export function stuckImports(
  db: D1Database,
  before: number,
  limit: number,
  after: { at: number; id: string } = { at: -1, id: '' },
): Promise<StuckImport[]> {
  return all<StuckImport>(
    db,
    `SELECT id, org_id, mode, check_id, email, email_budget, committed_at FROM pass_imports
     WHERE state = 'committing' AND committed_at < ? AND (committed_at, id) > (?, ?)
     ORDER BY committed_at, id LIMIT ?`,
    [before, after.at, after.id, limit],
  );
}

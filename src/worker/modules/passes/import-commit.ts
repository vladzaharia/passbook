import type { PassImportDto } from '../../../shared/contracts/pass-imports.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startRun } from '../../platform/workflow-runs.ts';
import type { TenantPassWrite } from './http.ts';
import { releaseImportEmail, reserveImportEmail } from './import-email.ts';
import { importDto } from './import-read.ts';
import { assertNotUndone, requireImport } from './import-service.ts';
import { type DeferredStarter, reissuePrincipalOf } from './repo-bulk-principal.ts';
import { beginCommit, revertCommit } from './repo-import-commit.ts';
import { emailableCount } from './repo-import-rows.ts';

/** One instance per commit: a re-commit after `stale` is a new run, and Workflows never reuse an id. */
export const importInstanceId = (id: string, checkId: string) => `pass-import-${id}-${checkId}`;

/**
 * The Workflow instance's status, `missing` when Workflows has no such id, `unknown` for any other failure
 * (logged under `code`): callers treat `unknown` as a live run.
 */
export async function instanceStatus(
  ctx: ServiceContext,
  instanceId: string,
  code: string,
): Promise<string> {
  try {
    return (await (await ctx.env.PASS_IMPORT.get(instanceId)).status()).status;
  } catch (error) {
    if (/not[_ ]found/i.test(error instanceof Error ? error.message : String(error)))
      return 'missing';
    ctx.log.warn('pass_import.instance_status_failed', { code, instanceId, error });
    return 'unknown';
  }
}

/** The starter of a request: a membership or a key, never a platform session (those act through a membership). */
export async function starterOf(ctx: ServiceContext, a: TenantPassWrite): Promise<DeferredStarter> {
  const principal = await reissuePrincipalOf(ctx.env.DB, a, undefined);
  if (principal === undefined || principal.kind === 'platform')
    throw new ConflictError('Sign in again to start this import.', 'IMPORT_STATE');
  return principal;
}

/**
 * Starts the commit of the checked plan: ready to committing for the `check_id` just read, then the workflow.
 * A repeat call returns the running (or finished) import.
 */
export async function commitImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
  body: {
    skipInvalid: boolean;
    email: boolean | { send: 'now' } | { send: 'held'; holdMs: number };
  },
): Promise<PassImportDto> {
  const imp = await requireImport(ctx, a, id);
  assertNotUndone(imp);
  if (imp.state === 'committing' || imp.state === 'done') return importDto(ctx, imp);
  const now = ctx.clock.now();
  if (imp.state === 'ready' && imp.expires_at <= now)
    throw new ConflictError('This import expired. Upload the file again.', 'IMPORT_EXPIRED');
  if (imp.state !== 'ready' || !imp.check_id)
    throw new ConflictError('Check the import before you commit it.', 'IMPORT_STATE');
  if (imp.errors > 0 && !body.skipInvalid)
    throw new ConflictError(
      `${imp.errors} rows have errors. Fix them or skip them.`,
      'IMPORT_HAS_ERRORS',
    );
  // `true` and `{send:'now'}` mail as each pass is made; `held` makes them first and mails after the wait.
  const mail = body.email === true ? { send: 'now' as const } : body.email || null;
  const holdMs = mail?.send === 'held' ? mail.holdMs : null;
  const reserved =
    mail?.send === 'now'
      ? await reserveImportEmail(
          ctx.env.DB,
          a.mode,
          a.orgId,
          now,
          await emailableCount(ctx.env.DB, id),
        )
      : 0;
  const reservation = {
    mode: a.mode,
    org_id: a.orgId,
    email: 1,
    email_budget: reserved,
    committed_at: now,
  };
  try {
    await beginCommit(ctx, a, id, {
      checkId: imp.check_id,
      email: mail !== null,
      holdMs,
      skipInvalid: body.skipInvalid,
      starter: await starterOf(ctx, a),
      emailBudget: reserved,
      templateId: imp.template_id,
      counts: { create: imp.to_create, update: imp.to_update, errors: imp.errors },
    });
  } catch (error) {
    await releaseImportEmail(ctx.env.DB, reservation);
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError('Another import of this template is running.', 'IMPORT_BUSY');
    throw error;
  }
  const instanceId = importInstanceId(id, imp.check_id);
  try {
    await startRun(
      ctx.env.DB,
      { instanceId, kind: 'pass_import', orgId: a.orgId, targetId: id, now },
      { ignoreDuplicate: true },
    );
    await ctx.env.PASS_IMPORT.create({
      id: instanceId,
      params: { importId: id, orgId: a.orgId, mode: a.mode },
    });
  } catch (error) {
    ctx.log.error('pass_import.workflow_start_failed', {
      orgId: a.orgId,
      importId: id,
      code: 'WORKFLOW_START_FAILED',
      error,
    });
    // An ambiguous failure may have created the instance: it then owns the commit.
    if ((await instanceStatus(ctx, instanceId, 'IMPORT_START_STATUS')) !== 'missing')
      return importDto(ctx, await requireImport(ctx, a, id));
    await revertCommit(ctx, a, id);
    await releaseImportEmail(ctx.env.DB, reservation);
    throw new UnavailableError('The import did not start. Try again.', 'WORKFLOW_START');
  }
  return importDto(ctx, await requireImport(ctx, a, id));
}

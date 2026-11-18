import type { PassImportDto } from '../../../shared/contracts/pass-imports.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startRun } from '../../platform/workflow-runs.ts';
import { orgEmailBudget } from '../delivery/repo-email-budget.ts';
import type { TenantPassWrite } from './http.ts';
import { importDto } from './import-read.ts';
import { requireImport } from './import-service.ts';
import { type DeferredStarter, reissuePrincipalOf } from './repo-bulk-principal.ts';
import { beginCommit, revertCommit } from './repo-import-commit.ts';

export const importInstanceId = (id: string) => `pass-import-${id}`;

/** The starter of a request: a membership or a key, never a platform session (those act through a membership). */
async function starterOf(ctx: ServiceContext, a: TenantPassWrite): Promise<DeferredStarter> {
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
  body: { skipInvalid: boolean; email: boolean },
): Promise<PassImportDto> {
  const imp = await requireImport(ctx, a, id);
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
  try {
    await beginCommit(ctx, a, id, {
      checkId: imp.check_id,
      email: body.email,
      skipInvalid: body.skipInvalid,
      starter: await starterOf(ctx, a),
      emailBudget: await orgEmailBudget(ctx.env.DB, a.mode, a.orgId, now),
      templateId: imp.template_id,
      counts: { create: imp.to_create, update: imp.to_update, errors: imp.errors },
    });
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError('Another import of this template is running.', 'IMPORT_BUSY');
    throw error;
  }
  const instanceId = importInstanceId(id);
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
    await revertCommit(ctx, a, id);
    throw new UnavailableError('The import did not start. Try again.', 'WORKFLOW_START');
  }
  return importDto(ctx, await requireImport(ctx, a, id));
}

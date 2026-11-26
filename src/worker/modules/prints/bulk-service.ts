import type { Mode } from '../../../shared/contracts/common.ts';
import type { BulkPrintStarted, BulkPrintStatus } from '../../../shared/contracts/prints.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { AuditEntry } from '../audit/types.ts';
import { progressOf } from '../operations/progress.ts';
import { failStarted, startOrgOperation } from '../operations/start-org.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { ScopeArg } from '../passes/scope.ts';
import { getTemplate } from '../templates/repo.ts';
import { readBulkStatus, writeBulkStatus } from './bulk-status.ts';
import { bulkKey, bulkMarkerKey } from './pdf-store.ts';
import { adminWriter } from './repo-write.ts';
import { ADMIN_PRINTS_PER_HOUR, mintPrint } from './service.ts';

/** Who asks: the signed-in user of an org in one mode, with the authority the route proved. */
export interface BulkCaller {
  authority: TenantPassWrite;
  userId: string;
  mode: Mode;
  actor: { type: AuditEntry['actorType']; id: string | null };
}

/**
 * Prints the selection's missing prints, records the job (who, mode, passes) beside its future PDF,
 * marks each pass so a void or purge can find the PDF, queues the render and audits. A pass of
 * another org or a missing id is "not found" for the whole selection.
 */
export async function startBulkPrint(
  ctx: ServiceContext,
  caller: BulkCaller,
  scope: ScopeArg,
  ids: string[],
): Promise<BulkPrintStarted> {
  const { authority } = caller;
  const unique = [...new Set(ids)];
  const rows = await Promise.all(unique.map((id) => getPass(ctx.env.DB, id, scope)));
  const passes = rows.filter((p): p is Pass => p !== null);
  if (passes.length !== unique.length)
    throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
  const writer = adminWriter(authority, caller.actor);
  const printer = { writer, limit: ADMIN_PRINTS_PER_HOUR };
  const printed: string[] = [];
  const skipped: BulkPrintStarted['skipped'] = [];
  for (const pass of passes) {
    if (pass.mode !== caller.mode) {
      skipped.push({ id: pass.id, code: 'MODE_MISMATCH' });
      continue;
    }
    try {
      await mintPrint(ctx, printer, pass, false);
      printed.push(pass.id);
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      const reason =
        error.code === 'PRINTING_OFF'
          ? `Paper is off for ${(await getTemplate(ctx.env.DB, pass.templateId))?.name ?? 'this template'}`
          : error.message;
      skipped.push({ id: pass.id, code: error.code, reason });
    }
  }
  if (printed.length === 0) return { jobId: '', count: 0, skipped, operationId: null };
  const orgId = authority.orgId;
  const jobId = ctx.ids.token(16);
  await Promise.all(printed.map((id) => ctx.env.BUCKET.put(bulkMarkerKey(orgId, id, jobId), '')));
  await writeBulkStatus(ctx.env.BUCKET, orgId, jobId, {
    state: 'pending',
    count: printed.length,
    skipped: 0,
    lossy: false,
    at: ctx.clock.now(),
    userId: caller.userId,
    mode: caller.mode,
    passIds: printed,
  });
  const op = await startOrgOperation(
    ctx,
    {
      type:
        caller.actor.type === 'user' || caller.actor.type === 'api_key'
          ? caller.actor.type
          : 'system',
      id: caller.actor.id,
    },
    { kind: 'prints.bulk', orgId, mode: caller.mode, target: { type: 'print-job', id: jobId } },
  );
  const pages = progressOf(ctx, op.id, op.attempt).step('pages');
  pages.total(printed.length);
  await pages.count(0);
  try {
    await ctx.env.JOBS.send({
      kind: 'prints.bulk',
      orgId,
      jobId,
      passIds: printed,
      operationId: op.id,
      attempt: op.attempt,
    });
  } catch (error) {
    await failStarted(ctx, op, error);
    throw error;
  }
  await recordAudit(ctx, {
    orgId,
    actorType: caller.actor.type,
    actorId: caller.actor.id,
    action: 'pass.print_bulk',
    targetType: 'org',
    targetId: orgId,
    detail: { count: printed.length, skipped: skipped.length },
  });
  return { jobId, count: printed.length, skipped, operationId: op.id };
}

type Who = { orgId: string; userId: string; mode: Mode };

/** The job's state for the user who started it, in its org and mode; anyone else gets "not found". */
export async function bulkPrintStatus(
  ctx: ServiceContext,
  who: Who,
  jobId: string,
): Promise<BulkPrintStatus> {
  const status = await readBulkStatus(ctx.env.BUCKET, who, jobId, ctx.clock.now());
  if (!status) throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
  return status;
}

/** The finished PDF, under the same rule as the status. */
export async function bulkPrintPdf(
  ctx: ServiceContext,
  who: Who,
  jobId: string,
): Promise<R2ObjectBody> {
  const status = await readBulkStatus(ctx.env.BUCKET, who, jobId, ctx.clock.now());
  const object =
    status?.state === 'ready' ? await ctx.env.BUCKET.get(bulkKey(who.orgId, jobId, 'pdf')) : null;
  if (!object) throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
  return object;
}

import type { Mode } from '../../../shared/contracts/common.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { failStarted, startOrgOperation } from '../operations/start-org.ts';
import { failExport } from './repo.ts';

/**
 * Makes the export's operation, then starts its Workflow under the export's id. The operation is first, so the
 * Workflow always finds its row. Returns the operation id, or null when no operation could be made (the export
 * still runs; the page falls back to its list).
 */
export async function launchExport(
  ctx: ServiceContext,
  x: { orgId: string; exportId: string; userId: string; mode: Mode },
): Promise<string | null> {
  let op: Awaited<ReturnType<typeof startOrgOperation>> | null = null;
  try {
    op = await startOrgOperation(
      ctx,
      { type: 'user', id: x.userId },
      {
        kind: 'org.export',
        orgId: x.orgId,
        mode: x.mode,
        target: { type: 'export', id: x.exportId },
        workflowInstanceId: x.exportId,
      },
    );
  } catch (error) {
    ctx.log.error('org.export_operation_failed', {
      orgId: x.orgId,
      code: 'ORG_EXPORT_OPERATION',
      error,
    });
  }
  try {
    await ctx.env.ORG_EXPORT.create({
      id: x.exportId,
      params: {
        orgId: x.orgId,
        exportId: x.exportId,
        ...(op ? { operationId: op.id, attempt: op.attempt } : {}),
      },
    });
  } catch (error) {
    ctx.log.error('org.export_start_failed', { orgId: x.orgId, code: 'ORG_EXPORT_START', error });
    await failExport(ctx.env.DB, x.exportId, 'ORG_EXPORT_START', ctx.clock.now());
    if (op)
      await failStarted(
        ctx,
        op,
        new AppError('ORG_EXPORT_START', 500, 'The export did not start.'),
      );
  }
  return op?.id ?? null;
}

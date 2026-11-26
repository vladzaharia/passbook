import type { ServiceContext } from '../../platform/service-context.ts';
import { finishRun } from './repo-runs.ts';
import { setWorkflowStatus } from './repo-sync.ts';
import { assertSyncAuthority } from './sync-runner-validation.ts';

/** Records a run that died outside the connector handling; a failure here is only logged. */
export async function recordAbort(
  sctx: ServiceContext,
  step: { do<T>(name: string, fn: () => Promise<T>): Promise<T> },
  p: Parameters<typeof assertSyncAuthority>[1] & { instanceId: string },
): Promise<void> {
  try {
    await step.do('abort-record', async () => {
      await assertSyncAuthority(sctx, p);
      const now = sctx.clock.now();
      await finishRun(
        sctx,
        {
          id: p.runId,
          connectionId: p.connectionId,
          finishedAt: now,
          outcome: 'error',
          recordsSeen: 0,
          passesChanged: 0,
          errorCode: 'INTERNAL',
          errorDetail: null,
          httpStatus: null,
          credentialKeysetCommitment: p.credentialKeysetCommitment,
          workflowInstanceId: p.instanceId,
        },
        { orgId: p.orgId },
      );
      await setWorkflowStatus(
        sctx.env.DB,
        p.instanceId,
        'errored',
        now,
        'INTERNAL',
        undefined,
        p.credentialKeysetCommitment,
        p,
      );
    });
  } catch {
    sctx.log.error('connection.sync_abort_record_failed', { code: 'INTERNAL' });
  }
}

/** The connection is gone: the workflow completes without a run record. */
export async function markGone(
  sctx: ServiceContext,
  step: { do<T>(name: string, fn: () => Promise<T>): Promise<T> },
  p: Parameters<typeof assertSyncAuthority>[1] & { instanceId: string },
): Promise<void> {
  await step.do('mark-gone', async () => {
    await assertSyncAuthority(sctx, p);
    await setWorkflowStatus(
      sctx.env.DB,
      p.instanceId,
      'complete',
      sctx.clock.now(),
      null,
      undefined,
      p.credentialKeysetCommitment,
      p,
    );
  });
}

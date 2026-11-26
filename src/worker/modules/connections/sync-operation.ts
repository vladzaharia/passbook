import type { Mode } from '../../../shared/contracts/common.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startOrgOperation } from '../operations/start-org.ts';
import type { ConnectionRow } from './repo.ts';

/** A user's Sync now reports as an operation: a new one for `actor`, or the one a retry restarts. */
export interface SyncOperation {
  actor: { type: 'user' | 'api_key' | 'system'; id: string | null };
  existing?: Pick<OperationDto, 'id' | 'attempt'>;
  /** Called when this start made the run (not when it joined one that was open). */
  onStarted?: (op: Pick<OperationDto, 'id' | 'attempt'>) => void;
}

export async function syncOperation(
  sctx: ServiceContext,
  conn: Pick<ConnectionRow, 'id' | 'orgId'>,
  mode: Mode,
  instanceId: string,
  operation: SyncOperation,
): Promise<Pick<OperationDto, 'id' | 'attempt'>> {
  const op =
    operation.existing ??
    (await startOrgOperation(sctx, operation.actor, {
      kind: 'connection.sync',
      orgId: conn.orgId,
      mode,
      target: { type: 'connection', id: conn.id },
      workflowInstanceId: instanceId,
    }));
  operation.onStarted?.(op);
  return op;
}

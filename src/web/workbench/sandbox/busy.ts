import { isOperationActive } from '../../lib/status-operations.ts';
import { useMineOperations } from '../../ui/operation/store.ts';
import type { Operation } from '../../ui/operation/types.ts';

/** The actions that leave a sandbox's tools unusable until they end. */
const BUSY_KINDS: ReadonlySet<string> = new Set(['sandbox.reset', 'sandbox.recreate']);

/**
 * The reset, start over or delete under way on this sandbox, read from the operations the tray already
 * holds (no poll of its own). A tool page shows "Resetting" while one runs.
 */
export function useSandboxBusy(
  orgId: string | undefined,
  /** The Sandbox page also follows a delete. */
  withDelete = false,
): Operation | undefined {
  const mine = useMineOperations();
  if (!orgId) return undefined;
  return mine.find(
    (op) =>
      (BUSY_KINDS.has(op.kind) || (withDelete && op.kind === 'sandbox.delete')) &&
      isOperationActive(op.status) &&
      (op.target?.id === orgId || op.orgId === orgId),
  );
}

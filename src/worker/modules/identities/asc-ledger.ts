import type { CallRow } from '../../../../workers/passbook-apple-connector/src/types.ts';

/** Read-only: this file may call the provisioner's `calls` and nothing else (tools/check-apple-binding.ts). */
interface LedgerBinding {
  APPLE?: { calls(since: number): Promise<CallRow[]> };
}

/** The provisioner's call ledger since `since` (ms), without Apple's request ids. `available: false` when it is not bound. */
export async function listAppleCalls(
  env: object,
  since: number,
): Promise<{ available: boolean; items: Omit<CallRow, 'appleRequestId'>[] }> {
  const rpc = (env as LedgerBinding).APPLE;
  if (!rpc) return { available: false, items: [] };
  const calls = await rpc.calls(since);
  return { available: true, items: calls.map(({ appleRequestId: _id, ...c }) => c) };
}

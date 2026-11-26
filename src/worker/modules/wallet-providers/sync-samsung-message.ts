import type { PassJson } from '../../../passkit/types.ts';
import { googleChangeMessage } from '../../../passkit/wallets/google/messages.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { eventRowOf } from '../events/record.ts';
import { passJsonsBetween, priorSucceededOperation } from './repo-instance-prior.ts';
import { insertWalletMessagedEvent } from './repo-wallet-messaged.ts';
import type { WalletSyncOperationExecution } from './sync-operation-context.ts';

/**
 * Samsung has no notifying call: a change message reaches the card as `noticeDesc` (`buildNotice` writes it
 * with the rest of the card) and Samsung decides what the holder is told. When an update carries a message
 * the ledger says so, as `updated` (the sync log's "Updated only"), once per operation however often it runs.
 */
export async function recordSamsungMessageOutcome(
  execution: WalletSyncOperationExecution,
): Promise<void> {
  const { ctx, op } = execution;
  const db = ctx.env.DB;
  const prior = await priorSucceededOperation(db, op.instanceId, op.version);
  if (prior?.kind !== 'upsert' || op.passVersion <= prior.passVersion) return;
  const raws = await passJsonsBetween(db, op.passId, prior.passVersion, op.passVersion);
  try {
    if (!googleChangeMessage(raws.map((raw) => JSON.parse(raw) as PassJson))) return;
  } catch {
    return;
  }
  const id = `wm-${(await sha256Hex(`wallet.messaged|${op.instanceId}|${op.version}`)).slice(0, 40)}`;
  const row = eventRowOf(
    {
      orgId: op.orgId,
      passId: op.passId,
      mode: op.mode,
      kind: 'wallet.messaged',
      actor: { type: 'system', id: null },
      data: { provider: 'samsung', outcome: 'updated', version: op.passVersion },
      at: ctx.clock.now(),
    },
    id,
    null,
  );
  await insertWalletMessagedEvent(db, row);
}

import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { currentPassJson } from '../passes/repo-read-pass.ts';
import { getWalletInstanceById } from './instance.ts';
import type { WalletOperation } from './instance-types.ts';
import { readPassSnapshot } from './repo-instance.ts';
import type { SamsungCardState } from './samsung-token.ts';

/** The expiry in the current pass.json, in epoch ms; null when there is none or it is unreadable. */
async function expiryOf(ctx: ServiceContext, passId: string): Promise<number | null> {
  const raw = await currentPassJson(ctx.env.DB, passId);
  if (raw === null) return null;
  try {
    const value = (JSON.parse(raw) as { expirationDate?: unknown }).expirationDate;
    const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** True when the last operation Samsung was told about was a revoke: this upsert undoes a void. */
async function followsRevoke(ctx: ServiceContext, op: WalletOperation): Promise<boolean> {
  const row = await first<{ kind: string }>(
    ctx.env.DB,
    `SELECT kind FROM wallet_provider_instance_operations
    WHERE instance_id = ? AND version < ? AND state = 'succeeded' ORDER BY version DESC LIMIT 1`,
    [op.instanceId, op.version],
  );
  return row?.kind === 'revoke';
}

/**
 * The state Samsung is sent (architecture 6.1). A void or quarantine is `CANCELED`; a removal, deletion,
 * transfer or channel-off is `DELETED`. An update is `EXPIRED` once the pass has expired, `ACTIVE` when it
 * undoes a void, else `UPDATED`. When the pass or instance cannot be read the answer is the old one, `DELETED`
 * for a revoke: a card is never left live for want of a read.
 */
export async function samsungOperationState(
  ctx: ServiceContext,
  op: WalletOperation,
): Promise<SamsungCardState> {
  if (op.kind === 'upsert') {
    const expiry = await expiryOf(ctx, op.passId);
    if (expiry !== null && expiry <= ctx.clock.now()) return 'EXPIRED';
    return (await followsRevoke(ctx, op)) ? 'ACTIVE' : 'UPDATED';
  }
  const pass = await readPassSnapshot(ctx.env.DB, op);
  const instance = await getWalletInstanceById(ctx.env.DB, op);
  const voidOnly =
    pass !== null &&
    instance !== null &&
    pass.removedAt === null &&
    pass.deletedAt === null &&
    pass.transferPending === 0 &&
    pass.credentialGeneration === op.credentialGeneration &&
    instance.retirementRequestedAt === null;
  return voidOnly ? 'CANCELED' : 'DELETED';
}

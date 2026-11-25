import type { ServiceContext } from '../../platform/service-context.ts';
import { readTimedSource, timedOrBuilt } from '../passes/timed-source.ts';
import { getWalletInstanceById } from './instance.ts';
import type { WalletOperation } from './instance-types.ts';
import { readPassSnapshot } from './repo-instance.ts';
import { priorSucceededOperation } from './repo-instance-prior.ts';
import type { SamsungCardState } from './samsung-token.ts';

/** The expiry of the pass as a wallet shows it now (its timed render), in epoch ms; null when there is none. */
async function expiryOf(ctx: ServiceContext, passId: string): Promise<number | null> {
  const source = await readTimedSource(ctx, passId);
  if (!source) return null;
  const { built, personalization, template } = source;
  const now = ctx.clock.now();
  const pass = template ? timedOrBuilt(ctx, passId, built, personalization, template, now) : built;
  const at = typeof pass.expirationDate === 'string' ? Date.parse(pass.expirationDate) : Number.NaN;
  return Number.isFinite(at) ? at : null;
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
    return (await priorSucceededOperation(ctx.env.DB, op.instanceId, op.version))?.kind === 'revoke'
      ? 'ACTIVE'
      : 'UPDATED';
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

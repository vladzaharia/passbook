import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletInstanceProof, WalletOperation } from './instance.ts';
import { queueWalletOperation as queue, readWalletPassSnapshot } from './instance.ts';
import { readAccountEpoch } from './repo-instance.ts';

type QueueInput = Omit<Parameters<typeof queue>[1], 'passRowVersion' | 'accountEpoch'> &
  Partial<Pick<WalletInstanceProof, 'passRowVersion' | 'accountEpoch'>>;

/** Queues with the pins current at the call, for tests that do not model a read before the write. */
export async function queueWalletOperation(
  ctx: ServiceContext,
  p: QueueInput,
): Promise<WalletOperation | null> {
  const db = ctx.env.DB;
  const passRowVersion = p.passRowVersion ?? (await readWalletPassSnapshot(db, p))?.passRowVersion;
  const accountEpoch = p.accountEpoch ?? (await readAccountEpoch(db, p.accountId));
  if (passRowVersion === undefined || accountEpoch === null || accountEpoch === undefined)
    return null;
  return queue(ctx, { ...p, passRowVersion, accountEpoch });
}

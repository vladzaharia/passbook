import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CredentialTransferSource } from '../passes/credential-transfer.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { getHolderPass } from './repo.ts';
import { assertNoTransfer, type TransferResult } from './service-operations.ts';

/** "Remove from my passes": stage the transfer and block re-attachment in the same transaction. */
export async function removePassFromUser(
  ctx: ServiceContext,
  passId: string,
  userId: string,
  sessionId: string,
  expectedSource?: CredentialTransferSource,
): Promise<TransferResult> {
  const pass = await getHolderPass(ctx.env.DB, passId, null);
  if (!pass || pass.ownerUserId !== userId)
    throw new ConflictError('The pass is no longer owned by this user.', 'PASS_CONFLICT');
  assertNoTransfer(pass);
  return startCredentialTransfer(
    ctx,
    { type: 'user', id: userId },
    pass.id,
    {
      holderEmail: expectedSource ? expectedSource.holderEmail : pass.holderEmail,
      ownerUserId: null,
    },
    null,
    {
      kind: 'self-remove',
      expected: expectedSource ?? pass,
      userId,
      sessionId,
      audit: {
        orgId: pass.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'holder.remove',
        targetType: 'pass',
        targetId: passId,
        detail: { block: true },
      },
    },
  );
}

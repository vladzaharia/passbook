import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CredentialTransferSource } from '../passes/credential-transfer.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { getHolderPass } from './repo.ts';
import { assertNoTransfer, type TransferResult } from './service-operations.ts';

/**
 * "I lost my phone": the owner keeps the pass and its email; the code and link are replaced and
 * every old copy stops working. The target is always the pass's own owner and email.
 */
export async function rotateOwnPassCredentials(
  ctx: ServiceContext,
  passId: string,
  userId: string,
  sessionId: string,
  expectedSource: CredentialTransferSource,
): Promise<TransferResult> {
  const pass = await getHolderPass(ctx.env.DB, passId, null);
  if (!pass || pass.ownerUserId !== userId || !pass.holderEmail)
    throw new ConflictError('The pass is no longer owned by this user.', 'PASS_CONFLICT');
  assertNoTransfer(pass);
  return startCredentialTransfer(
    ctx,
    { type: 'user', id: userId },
    passId,
    { holderEmail: pass.holderEmail, ownerUserId: userId },
    null,
    {
      kind: 'self-rotate',
      expected: expectedSource,
      userId,
      sessionId,
      audit: {
        orgId: pass.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'holder.lost_phone',
        targetType: 'pass',
        targetId: passId,
      },
    },
  );
}

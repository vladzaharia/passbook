import type { SetSamsungCard } from '../../../shared/contracts/wallet-provider-actions.ts';
import type { WalletCredential } from '../../../shared/contracts/wallet-providers.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-credential-material.ts';
import { openSourceVersion } from './account-credential-source.ts';
import { changed, platformWriter, save, withLastCheck } from './credential-service.ts';
import type { WalletPlatformCaller } from './platform-caller.ts';
import { findCheckTarget } from './repo-credential-checks.ts';
import { findCredential } from './repo-credentials.ts';

/**
 * Names the Samsung card of one more type on a platform credential. The secrets stay where they are: the
 * current version is opened, the card added and the credential saved as a new version, which the save path
 * checks like any rotation (card ids are append-only, the partner identity cannot change) and queues a
 * credential check for. A type that already has a different card is a conflict; the same card again is a no-op.
 */
export async function setPlatformSamsungCard(
  ctx: ServiceContext,
  auth: WalletPlatformCaller,
  id: string,
  input: SetSamsungCard,
): Promise<WalletCredential> {
  ctx = snapshotWalletCredentialContext(ctx);
  const w = platformWriter(auth, 'platform.wallet.credential_save');
  const row = await findCredential(ctx.env.DB, id, null);
  if (row?.provider !== 'samsung' || row.revoked_at !== null) throw new NotFoundError();
  if (row.revision !== input.expectedRevision) throw changed();
  const target = await findCheckTarget(ctx.env.DB, id);
  if (!target) throw new NotFoundError();
  const opened = await openSourceVersion(
    ctx,
    { id: '', orgId: '', mode: row.mode, provider: 'samsung' },
    target,
  );
  if (opened.provider !== 'samsung') throw new NotFoundError();
  const held = opened.credentials.cardIds?.[input.type];
  if (held === input.cardId) return withLastCheck(ctx, null, row);
  if (
    held !== undefined ||
    (input.type === 'loyalty' && opened.credentials.cardId !== input.cardId)
  )
    throw new ConflictError('This type already has a card.', 'WALLET_CARD_SET');
  const saved = await save(
    ctx,
    w,
    { orgId: null, mode: row.mode },
    {
      provider: 'samsung',
      expectedRevision: row.revision,
      credentials: {
        ...opened.credentials,
        cardIds: { ...opened.credentials.cardIds, [input.type]: input.cardId },
      },
    },
  );
  return withLastCheck(ctx, null, saved);
}

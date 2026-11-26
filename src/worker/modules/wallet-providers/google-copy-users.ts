import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { projectionGoogleType } from './google-compile.ts';
import { getWalletInstance, getWalletOperation } from './instance.ts';
import { googleRuntimeHasUsers } from './runtime.ts';
import { originalScope } from './sync-operation-context.ts';

/**
 * Whether Google reports users on a pass's live Google object: the provider's own answer when a save callback
 * may have been lost. Null when it cannot be asked (no live copy, an account that cannot be used, a failed
 * read): the caller then treats the copy as held.
 */
export async function googleCopyHasUsers(
  ctx: ServiceContext,
  pass: { id: string; orgId: string; mode: Mode },
): Promise<boolean | null> {
  const db = ctx.env.DB;
  try {
    const scope = { orgId: pass.orgId, mode: pass.mode, provider: 'google' as const };
    const instance = await getWalletInstance(db, { ...scope, passId: pass.id });
    if (instance?.lifecycle !== 'active') return null;
    const op = await getWalletOperation(db, {
      ...scope,
      instanceId: instance.id,
      version: instance.desiredVersion,
    });
    const binding = op ? await originalScope(ctx, op) : null;
    if (!op || !binding) return null;
    return await googleRuntimeHasUsers(ctx, binding.scope, {
      releaseId: op.identityProjectionReleaseId,
      passId: op.passId,
      credentialGeneration: op.credentialGeneration,
      channelEpoch: op.channelEpoch,
      ...(binding.original.projection.schema === 2
        ? { type: projectionGoogleType(binding.original.projection) }
        : {}),
    });
  } catch {
    // Provider errors can carry message content: the caller logs the code.
    return null;
  }
}

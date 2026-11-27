import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { releaseLease } from '../operations/repo.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import type { WalletProvider } from './instance-types.ts';
import { assertWalletProviderEnabled } from './provider-policy.ts';
import { limitReissues } from './reissue-limit.ts';
import { startWalletReissue } from './wallet-reissue.ts';

/** The target names what the run was for: `google`, or `google:<templateId>`. */
function scopeOf(op: {
  orgId: string | null;
  mode: 'live' | 'test' | null;
  target: { id: string } | null;
}) {
  const [provider, templateId] = (op.target?.id ?? '').split(':');
  if (!op.orgId || !op.mode || (provider !== 'google' && provider !== 'samsung'))
    throw new NotFoundError('Operation not found.', 'OPERATION_NOT_FOUND');
  return {
    orgId: op.orgId,
    mode: op.mode,
    provider: provider as WalletProvider,
    ...(templateId ? { templateId } : {}),
  };
}

/** The retry's own checks are the start's: passes:operate, a released provider, and the hourly limits. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, op, caller) => {
  if (caller.kind === 'scanner') throw new ForbiddenError();
  const scope = scopeOf(op);
  if (caller.mode !== scope.mode)
    throw new NotFoundError('Operation not found.', 'OPERATION_NOT_FOUND');
  await tenantAuthorityOf(ctx, caller, scope.orgId, 'passes:operate');
  assertWalletProviderEnabled(scope.provider, scope.mode);
  await limitReissues(ctx, caller.kind === 'api_key' ? caller.keyId : null, scope.orgId);
};

/**
 * Starts the chain again for the operation's next attempt, under a chain of its own. The lease `operation.run`
 * took is let go first: the chain's jobs write without one, and a held lease would refuse them.
 */
const run: NonNullable<OperationRunner['run']> = async (ctx, op, lease) => {
  await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
  await startWalletReissue(ctx, scopeOf(op), {
    actor: { type: op.startedBy.type, id: op.startedBy.id },
    existing: op,
    fresh: true,
  });
};

export const operationRunners: OperationRunners = {
  'wallet.reissue': { run, authorizeRetry },
};

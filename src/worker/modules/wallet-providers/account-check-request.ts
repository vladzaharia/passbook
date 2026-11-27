import type {
  WalletCredentialCheckQueued,
  WalletCredentialCheckResult,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { bump } from '../../platform/counters.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { isActor, type PlatformCaller } from './platform-caller.ts';
import { findCheck } from './repo-credential-checks.ts';
import { findCredential } from './repo-credentials.ts';

const CHECKS_PER_HOUR = 10;

type Scope = { orgId: string } | { orgId: null };

/** The credential in its scope, or 404: an org reaches its own credentials of the session mode, never another's. */
async function scoped(
  ctx: ServiceContext,
  auth: SessionAuth | PlatformCaller,
  scope: Scope,
  id: string,
  write: boolean,
) {
  if (isActor(auth)) {
    // A platform route's gate admitted it; an org's credential is never its scope.
    if (scope.orgId !== null) throw new ForbiddenError();
    const row = await findCredential(ctx.env.DB, id, null);
    if (!row) throw new NotFoundError();
    return row;
  }
  if (auth?.kind !== 'session') throw new ForbiddenError();
  if (scope.orgId === null) {
    if (!auth.roles.includes('admin')) throw new ForbiddenError('Admin access is required.');
  } else
    await tenantAuthorityOf(
      ctx,
      auth,
      scope.orgId,
      write ? 'integrations:manage' : 'integrations:read',
    );
  const row = await findCredential(ctx.env.DB, id, scope.orgId);
  if (!row || (scope.orgId !== null && row.mode !== auth.mode)) throw new NotFoundError();
  return row;
}

/** Queues a check of the credential's current version. `check_request` only enqueues: the job holds the write. */
export async function requestCredentialCheck(
  ctx: ServiceContext,
  auth: PlatformCaller,
  scope: Scope,
  id: string,
): Promise<WalletCredentialCheckQueued> {
  const row = await scoped(ctx, auth, scope, id, true);
  if (row.revoked_at !== null || row.current_version_id === null)
    throw new ConflictError('The wallet credential cannot be checked.', 'WALLET_ACCOUNT_CONFLICT');
  const hour = 3_600_000;
  const windowStart = Math.floor(ctx.clock.now() / hour) * hour;
  if ((await bump(ctx.env.DB, `walletcheck:${row.id}`, windowStart)) > CHECKS_PER_HOUR)
    throw new RateLimitedError();
  const checkId = ctx.ids.id();
  await ctx.env.JOBS.send({ kind: 'wallet.credential_check', credentialId: row.id, checkId });
  return { checkId, status: 'queued' };
}

export async function readCredentialCheck(
  ctx: ServiceContext,
  auth: PlatformCaller,
  scope: Scope,
  id: string,
  checkId: string,
): Promise<WalletCredentialCheckResult> {
  const row = await scoped(ctx, auth, scope, id, false);
  const check = await findCheck(ctx.env.DB, row.id, checkId);
  if (!check) return { checkId, status: 'pending', code: null, checkedAt: null };
  return {
    checkId,
    status: check.ok === 1 ? 'ok' : 'failed',
    code: check.code,
    checkedAt: check.checked_at,
  };
}

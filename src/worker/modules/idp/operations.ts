import { AppError, ForbiddenError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { breakerRun, checkRun, restoreRun } from './ops-runs.ts';

/** A retry runs the start's checks again: a platform admin signed in with Polaris ID (no break-glass), and the rate limit. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, op, caller) => {
  // A retry cannot help these: a new trip needs the feed checked, and an unwanted role stays unwanted.
  if (op.error?.code === 'IDP_BREAKER_RETRIPPED')
    throw new AppError(
      'IDP_BREAKER_RETRIPPED',
      409,
      'The breaker tripped again. Check the feed, then clear it again.',
    );
  if (op.error?.code === 'IDP_NOT_WANTED')
    throw new AppError('IDP_NOT_WANTED', 409, 'Nothing wants this role now.');
  if (caller.kind !== 'session' || !caller.roles.includes('admin') || caller.amr !== 'oidc')
    throw new ForbiddenError(
      'Sign in with Polaris ID as a platform admin.',
      'IDP_SIGN_IN_REQUIRED',
    );
  await enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:idp-ops:${caller.userId}`);
};

export const operationRunners: OperationRunners = {
  'idp.check': { run: (ctx, op, lease) => checkRun(ctx, op, lease, false), authorizeRetry },
  'idp.dry_run': { run: (ctx, op, lease) => checkRun(ctx, op, lease, true), authorizeRetry },
  'idp.restore': { run: restoreRun, authorizeRetry },
  'idp.breaker_clear': { run: breakerRun, authorizeRetry },
};

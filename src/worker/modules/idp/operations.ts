import { ForbiddenError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { offboardRun } from './ops-offboard.ts';
import { breakerRun, checkRun, restoreRun } from './ops-runs.ts';

/** A retry runs the start's checks again: a platform admin signed in with Polaris ID (no break-glass), and the rate limit. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, _op, caller) => {
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
  'idp.offboard': { run: offboardRun, authorizeRetry },
};

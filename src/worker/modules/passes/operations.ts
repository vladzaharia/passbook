import { ForbiddenError } from '../../platform/errors.ts';
import type { OperationRunners } from '../operations/registry.ts';
import { runIdentityMove } from './identity-move-run.ts';

export const operationRunners: OperationRunners = {
  'identity.move': {
    run: (ctx, op, lease) => runIdentityMove(ctx, op, lease),
    // The row is a platform row, so the service already hides it from keys; this refuses them again.
    // A move writes Live passes and pushes them: a person at the console, never a token.
    authorizeRetry: async (_ctx, _op, caller) => {
      if (caller.kind !== 'session' || !caller.roles.includes('admin')) throw new ForbiddenError();
    },
  },
};

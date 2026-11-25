import { failTarget, noteDrift, type Who } from './effects.ts';
import { idpCodeOf } from './errors.ts';
import type { DrainOutcome, RunEnv, Touched } from './run-env.ts';

/**
 * Sorts a failure into what the run does next. A breaker or a freeze stops the run and leaves the mark due; a
 * budget backs the subject off and stops the run; an upstream failure or a lease conflict backs off and carries
 * on; a drift is recorded and never retried; a refusal stays on the record and is not retried.
 */
export async function failure(
  env: RunEnv,
  subject: string,
  touched: Touched,
  error: unknown,
): Promise<Omit<DrainOutcome, 'targets'>> {
  const { ctx } = env;
  const code = idpCodeOf(error);
  const who: Who = { subject, userId: null };
  const record = async (stable: string) => {
    if (env.dry) return;
    for (const target of touched.targets) await failTarget(ctx, who, target, stable);
  };
  switch (code) {
    case 'IDP_BREAKER':
      ctx.log.error('idp.drain.breaker', { code, subject });
      return { mark: 'keep', stop: true };
    case 'IDP_FROZEN':
      ctx.log.warn('idp.drain.frozen', { code, subject });
      return { mark: 'keep', stop: true };
    case 'IDP_BUDGET':
      ctx.log.warn('idp.drain.budget', { code, subject });
      return { mark: 'fail', stop: true };
    case 'IDP_UPSTREAM':
    case 'IDP_CONFLICT':
      ctx.log.warn('idp.drain.retry', { code, subject });
      return { mark: 'fail', stop: false };
    case 'IDP_NOT_FOUND':
      ctx.log.info('idp.drain.account_gone', { subject });
      await record(code);
      return { mark: 'clear', stop: false };
    case 'IDP_DRIFT':
      ctx.log.error('idp.drain.drift', { code, subject });
      for (const target of touched.targets)
        await noteDrift(ctx, env.runId, who, target, 'apply_failed');
      return { mark: 'clear', stop: false };
    case 'IDP_REFUSED':
    case 'IDP_NOT_MANAGED':
    case 'IDP_IN_USE':
      ctx.log.warn('idp.drain.refused', { code, subject });
      await record(code);
      return { mark: 'clear', stop: false };
    case 'IDP_AUTH':
    case 'IDP_UNSAFE_CONFIG':
    case 'IDP_MISCONFIGURED':
      ctx.log.error('idp.drain.misconfigured', { code, subject });
      return { mark: 'fail', stop: true };
    default:
      ctx.log.error('idp.drain.failed', { code: 'IDP_DRAIN_FAILED', subject, error });
      return { mark: 'fail', stop: false };
  }
}

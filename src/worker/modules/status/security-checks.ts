import type { z } from 'zod';
import type { ComponentStatusSchema } from '../../../shared/contracts/status.ts';
import { envString, RATE_LIMITS } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dayStart } from '../auth/magic-caps.ts';
import { readCounter } from '../auth/magic-repo.ts';
import { lastBreakglassUse } from './repo.ts';

type Draft = Omit<z.infer<typeof ComponentStatusSchema>, 'checkedAt'>;

/** Fails when any rate-limit binding is gone: those requests are refused, not allowed. */
export function checkRateLimits(ctx: ServiceContext): Draft {
  const env = ctx.env as unknown as Record<string, { limit?: unknown } | undefined>;
  const data: Record<string, string> = {};
  for (const name of RATE_LIMITS)
    data[name] = typeof env[name]?.limit === 'function' ? 'present' : 'missing';
  const missing = RATE_LIMITS.filter((n) => data[n] === 'missing');
  return {
    id: 'ratelimits',
    kind: 'build',
    label: 'Rate limits',
    state: missing.length > 0 ? 'failing' : 'verified',
    detail: missing.length > 0 ? `Missing ${missing.join(', ')}.` : null,
    data,
  };
}

export async function checkBreakglass(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'breakglass', kind: 'oidc', label: 'Break-glass' } as const;
  if (!/^[0-9a-f]{64}$/i.test(envString(ctx.env, 'BREAKGLASS_TOKEN_SHA256')?.trim() ?? ''))
    return { ...base, state: 'not_configured', detail: 'Off.' };
  const [lastUsedAt, failuresToday] = await Promise.all([
    lastBreakglassUse(ctx.env.DB),
    readCounter(ctx.env.DB, 'breakglass:fail', dayStart(ctx.clock.now())),
  ]);
  return {
    ...base,
    state: failuresToday > 0 ? 'degraded' : 'configured',
    detail: failuresToday > 0 ? `${failuresToday} wrong tokens today.` : null,
    data: { lastUsedAt, failuresToday },
  };
}

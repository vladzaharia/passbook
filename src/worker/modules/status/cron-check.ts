import type { ServiceContext } from '../../platform/service-context.ts';
import type { Component } from './checks.ts';
import { lastCronRun } from './cron.ts';

type Draft = Omit<Component, 'checkedAt'>;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A deployed worker (https, not loopback): crons are expected to run there. */
export function isDeployed(env: { PUBLIC_BASE_URL?: string }): boolean {
  try {
    const url = new URL(env.PUBLIC_BASE_URL ?? '');
    return url.protocol === 'https:' && !/^(localhost|127\.|\[::1\])/.test(url.hostname);
  } catch {
    // An unparsable base URL is a misconfiguration surfaced elsewhere; treat it as local here.
    return false;
  }
}

export async function checkCron(ctx: ServiceContext): Promise<Draft[]> {
  const now = ctx.clock.now();
  const deployed = isDeployed(ctx.env);
  const one = async (name: 'minute' | 'daily', maxAge: number): Promise<Draft> => {
    const at = await lastCronRun(ctx, name);
    const base = {
      id: `cron:${name}`,
      kind: 'cron',
      label: name === 'minute' ? 'Cron (minute)' : 'Cron (daily)',
    } as const;
    // Deployed, a cron with no run in a day is a problem; locally crons never fire.
    if (deployed && (at === null || now - at > DAY))
      return {
        ...base,
        state: 'degraded',
        detail: 'No recent run.',
        data: { lastRunAt: at, noRecentRun: true },
      };
    const stale = at !== null && now - at > maxAge;
    return {
      ...base,
      state: at === null ? 'configured' : stale ? 'degraded' : 'verified',
      detail: at === null ? 'No run recorded.' : stale ? 'Last run is overdue.' : null,
      data: { lastRunAt: at },
    };
  };
  return [await one('minute', 5 * MINUTE), await one('daily', 26 * HOUR)];
}

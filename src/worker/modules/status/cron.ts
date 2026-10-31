import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';

export type CronName = 'minute' | 'daily';

/** Cron hooks call this when a run finishes; status reads it back. */
export async function recordCronRun(ctx: ServiceContext, name: CronName): Promise<void> {
  await writeSystemValue(ctx.env.DB, `cron.${name}`, { at: ctx.clock.now() }, ctx.clock.now());
}

export async function lastCronRun(ctx: ServiceContext, name: CronName): Promise<number | null> {
  const value = (await readSystemValue(ctx.env.DB, `cron.${name}`)) as { at?: number } | null;
  return typeof value?.at === 'number' ? value.at : null;
}

import { DEFAULT_TIME_ZONE, resolveOrgTimeZone } from '../../../shared/time-zone.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { daysBetween, followingPeriod, type Period, periodAt, validZone } from './periods.ts';
import {
  closeRecounts,
  insertDays,
  insertPeriod,
  latestPeriod,
  PERIOD_LEAD_MS,
  type PeriodRow,
  periodRowsBetween,
  sumDaily,
} from './repo-daily.ts';

export type UsageMeter = 'passes_issued' | 'emails';

/** How far ahead day bounds are prepared. The next period itself is created `PERIOD_LEAD_MS` before it starts. */
export const HORIZON_MS = 36 * 3_600_000;
const MAX_CATCH_UP = 24;

const asPeriod = (r: PeriodRow): Period => ({
  month: r.month,
  startMs: r.start_ms,
  endMs: r.end_ms,
});

/**
 * Brings one org's periods up to date: the period holding now and the next one when it is within the horizon,
 * the local-day bounds for both, and the recount windows that have closed. A new period takes the org's zone as
 * it stands just before it starts, so a zone change applies from the next month; an unusable zone falls back to
 * the default zone, flagged.
 */
export async function syncOrgUsage(ctx: ServiceContext, orgId: string): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const setting = (await getOrgSettings(ctx, orgId))['org.timeZone'];
  const wanted = resolveOrgTimeZone(setting);
  const usable = validZone(wanted);
  const zone = usable ? wanted : DEFAULT_TIME_ZONE;

  let latest = await latestPeriod(db, orgId);
  if (!latest) {
    await insertPeriod(db, orgId, periodAt(now, zone), zone, !usable, now);
    latest = await latestPeriod(db, orgId);
  }
  for (let i = 0; latest && latest.end_ms <= now + PERIOD_LEAD_MS && i < MAX_CATCH_UP; i++) {
    await insertPeriod(db, orgId, followingPeriod(asPeriod(latest), zone), zone, !usable, now);
    latest = await latestPeriod(db, orgId);
  }

  for (const row of await periodRowsBetween(db, orgId, now, now + HORIZON_MS + 1)) {
    const period = asPeriod(row);
    const to = Math.min(now + HORIZON_MS, period.endMs);
    await insertDays(
      db,
      orgId,
      period.startMs,
      daysBetween(period, row.time_zone, period.startMs, to),
    );
  }
  await closeRecounts(db, orgId, now);
}

/** What an org used of a meter in the period named `month` (`YYYY-MM`). */
export const usageForMonth = (
  ctx: ServiceContext,
  orgId: string,
  meter: UsageMeter,
  month: string,
): Promise<number> => sumDaily(ctx.env.DB, orgId, meter, month);
